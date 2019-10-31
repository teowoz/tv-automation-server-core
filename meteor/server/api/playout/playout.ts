
/* tslint:disable:no-use-before-declare */
import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import { Rundowns, Rundown, RundownHoldState, PlayoutRundownData } from '../../../lib/collections/Rundowns'
import { Part, Parts, DBPart } from '../../../lib/collections/Parts'
import { Piece, Pieces } from '../../../lib/collections/Pieces'
import { getCurrentTime,
	Time,
	fetchAfter,
	asyncCollectionUpdate,
	waitForPromiseAll,
	asyncCollectionInsert,
	asyncCollectionUpsert,
	waitForPromise,
	makePromise,
	clone,
	literal,
	asyncCollectionRemove} from '../../../lib/lib'
import { Timeline, TimelineObjGeneric } from '../../../lib/collections/Timeline'
import { Segments, Segment } from '../../../lib/collections/Segments'
import { Random } from 'meteor/random'
import * as _ from 'underscore'
import { logger } from '../../logging'
import {
	PieceLifespan,
	PartHoldMode,
	VTContent,
	PartEndState
} from 'tv-automation-sofie-blueprints-integration'
import { Studios } from '../../../lib/collections/Studios'
import { getResolvedSegment, ISourceLayerExtended } from '../../../lib/Rundown'
import { ClientAPI } from '../../../lib/api/client'
import {
	reportRundownHasStarted,
	reportPartHasStarted,
	reportPieceHasStarted,
	reportPartHasStopped,
	reportPieceHasStopped
} from '../asRunLog'
import { Blueprints } from '../../../lib/collections/Blueprints'
import { getBlueprintOfRundown } from '../blueprints/cache'
import { PartEventContext, PartContext, RundownContext } from '../blueprints/context'
import { IngestActions } from '../ingest/actions'
import { updateTimeline } from './timeline'
import {
	resetRundown as libResetRundown,
	setNextPart as libSetNextPart,
	onPartHasStoppedPlaying,
	refreshPart,
	getPreviousPartForSegment
} from './lib'
import {
	prepareStudioForBroadcast,
	activateRundown as libActivateRundown,
	deactivateRundown as libDeactivateRundown,
	deactivateRundownInner
} from './actions'
import { PieceResolved, getOrderedPiece, getResolvedPieces, convertAdLibToPiece, convertPieceToAdLibPiece, resolveActivePieces } from './pieces'
import { PackageInfo } from '../../coreSystem'
import { areThereActiveRundownsInStudio } from './studio'
import { updateSourceLayerInfinitesAfterPart, cropInfinitesOnLayer, stopInfinitesRunningOnLayer } from './infinites'
import { rundownSyncFunction, RundownSyncFunctionPriority } from '../ingest/rundownInput'
import { ServerPlayoutAdLibAPI } from './adlib'
import { PartInstance, PartInstances } from '../../../lib/collections/PartInstances'

export namespace ServerPlayoutAPI {
	/**
	 * Prepare the rundown for transmission
	 * To be triggered well before the broadcast, since it may take time and cause outputs to flicker
	 */
	export function prepareRundownForBroadcast (rundownId: string) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.active) throw new Meteor.Error(404, `rundownPrepareForBroadcast cannot be run on an active rundown!`)

			const anyOtherActiveRundowns = areThereActiveRundownsInStudio(rundown.studioId, rundown._id)
			if (anyOtherActiveRundowns.length) {
				// logger.warn('Only one rundown can be active at the same time. Active rundowns: ' + _.map(anyOtherActiveRundowns, rundown => rundown._id))
				throw new Meteor.Error(409, 'Only one rundown can be active at the same time. Active rundowns: ' + _.map(anyOtherActiveRundowns, rundown => rundown._id))
			}

			libResetRundown(rundown)
			prepareStudioForBroadcast(rundown.getStudio())

			return libActivateRundown(rundown, true) // Activate rundown (rehearsal)
		})
	}
	/**
	 * Reset the broadcast, to be used during testing.
	 * The User might have run through the rundown and wants to start over and try again
	 */
	export function resetRundown (rundownId: string) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.active && !rundown.rehearsal) throw new Meteor.Error(401, `rundownResetBroadcast can only be run in rehearsal!`)

			libResetRundown(rundown)

			updateTimeline(rundown.studioId)

			return { success: 200 }
		})
	}
	/**
	 * Activate the rundown, final preparations before going on air
	 * To be triggered by the User a short while before going on air
	 */
	export function resetAndActivateRundown (rundownId: string, rehearsal?: boolean) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.active && !rundown.rehearsal) throw new Meteor.Error(402, `rundownResetAndActivate cannot be run when active!`)

			libResetRundown(rundown)

			return libActivateRundown(rundown, !!rehearsal) // Activate rundown
		})
	}
	/**
	 * Activate the rundown, decativate any other running rundowns
	 */
	export function forceResetAndActivateRundown (rundownId: string, rehearsal: boolean) {
		check(rehearsal, Boolean)
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			let anyOtherActiveRundowns = areThereActiveRundownsInStudio(rundown.studioId, rundown._id)
			let error: any
			_.each(anyOtherActiveRundowns, (otherRundown) => {
				try {
					deactivateRundownInner(otherRundown)
				} catch (e) {
					error = e
				}
			})
			if (error) {
				// Ok, something went wrong, but check if the active rundowns where deactivated?
				anyOtherActiveRundowns = areThereActiveRundownsInStudio(rundown.studioId, rundown._id)
				if (anyOtherActiveRundowns.length) {
					// No they weren't, we can't continue..
					throw error
				} else {
					// They where deactivated, log the error and continue
					logger.error(error)
				}
			}

			libResetRundown(rundown)

			return libActivateRundown(rundown, rehearsal)
		})
	}
	/**
	 * Only activate the rundown, don't reset anything
	 */
	export function activateRundown (rundownId: string, rehearsal: boolean) {
		check(rehearsal, Boolean)
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			return libActivateRundown(rundown, rehearsal)
		})
	}
	/**
	 * Deactivate the rundown
	 */
	export function deactivateRundown (rundownId: string) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			return libDeactivateRundown(rundown)
		})
	}
	/**
	 * Trigger a reload of data of the rundown
	 */
	export function reloadData (rundownId: string) {
		// Reload and reset the Rundown
		check(rundownId, String)
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			return ClientAPI.responseSuccess(
				IngestActions.reloadRundown(rundown)
			)
		})
	}
	/**
	 * Take the currently Next:ed Part (start playing it)
	 */
	export function takeNextPart (rundownId: string): ClientAPI.ClientResponse {
		let now = getCurrentTime()
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			let rundown = Rundowns.findOne(rundownId) as Rundown
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundownId}" is not active!`)
			if (!rundown.nextPartInstanceId) throw new Meteor.Error(500, 'nextPartInstanceId is not set!')

			let timeOffset: number | null = rundown.nextTimeOffset || null

			let firstTake = !rundown.startedPlayback
			let rundownData = rundown.fetchAllData()

			let pBlueprint = makePromise(() => getBlueprintOfRundown(rundown))

			const currentPartInstance = rundown.currentPartInstanceId ? rundownData.partInstancesMap[rundown.currentPartInstanceId] : undefined
			if (currentPartInstance && currentPartInstance.part.transitionDuration) {
				const prevPartInstance = rundown.previousPartInstanceId ? rundownData.partInstancesMap[rundown.previousPartInstanceId] : undefined
				const allowTransition = prevPartInstance && !prevPartInstance.part.disableOutTransition
				// If there was a transition from the previous Part, then ensure that has finished before another take is permitted
				if (allowTransition) {
					const start = currentPartInstance.timings.startedPlayback
					if (start && now < start + currentPartInstance.part.transitionDuration) {
						return ClientAPI.responseError('Cannot take during a transition')
					}
				}
			}

			if (rundown.holdState === RundownHoldState.COMPLETE) {
				Rundowns.update(rundown._id, {
					$set: {
						holdState: RundownHoldState.NONE
					}
				})
			// If hold is active, then this take is to clear it
			} else if (rundown.holdState === RundownHoldState.ACTIVE) {
				const ps: Promise<any>[] = []
				ps.push(asyncCollectionUpdate(Rundowns, rundown._id, {
					$set: {
						holdState: RundownHoldState.COMPLETE
					}
				}))

				if (rundown.currentPartInstanceId) {
					if (!currentPartInstance) throw new Meteor.Error(404, 'currentPart not found!')

					// Remove the current extension line
					ps.push(asyncCollectionRemove(Pieces, {
						partId: currentPartInstance.part._id,
						extendOnHold: true,
						dynamicallyInserted: true
					}))
				}
				if (rundown.previousPartInstanceId) {
					const prevPartInstance = rundownData.partInstancesMap[rundown.previousPartInstanceId]
					if (!prevPartInstance) throw new Meteor.Error(404, 'previousPart not found!')

					// Clear the extended mark on the original
					ps.push(asyncCollectionUpdate(Pieces, {
						partId: prevPartInstance.part._id,
						extendOnHold: true,
						dynamicallyInserted: false
					}, {
						$unset: {
							infiniteId: 0,
							infiniteMode: 0,
						}
					}, { multi: true }))
				}
				waitForPromiseAll(ps)
				updateTimeline(rundown.studioId)
				return ClientAPI.responseSuccess()
			}

			const previousPart = currentPartInstance || null

			const takePartInstance = rundownData.partInstancesMap[rundown.nextPartInstanceId]
			if (!takePartInstance) throw new Meteor.Error(404, 'takePartInstance not found!')
			// let takeSegment = rundownData.segmentsMap[takePart.segmentId]
			let partAfter = fetchAfter(rundownData.parts, {
				rundownId: rundown._id,
				invalid: { $ne: true }
			}, takePartInstance.part._rank)

			let nextPart: DBPart | null = partAfter || null

			// beforeTake(rundown, previousPart || null, takePart)
			beforeTake(rundownData, previousPart || null, takePartInstance)


			const { blueprint } = waitForPromise(pBlueprint)
			if (blueprint.onPreTake) {
				try {
					waitForPromise(
						Promise.resolve(blueprint.onPreTake(new PartEventContext(rundown, undefined, takePartInstance)))
						.catch(logger.error)
					)
				} catch (e) {
					logger.error(e)
				}
			}
			// TODO - the state could change after this sampling point. This should be handled properly
			let previousPartEndState: PartEndState | undefined = undefined
			if (blueprint.getEndStateForPart && previousPart) {
				const time = getCurrentTime()
				const resolvedPieces = getResolvedPieces(previousPart)

				const context = new RundownContext(rundown)
				previousPartEndState = blueprint.getEndStateForPart(context, rundown.previousPersistentState, previousPart.previousPartEndState, resolvedPieces, time)
				logger.info(`Calculated end state in ${getCurrentTime() - time}ms`)
			}
			let ps: Array<Promise<any>> = []
			let m: Partial<Rundown> = {
				previousPartInstanceId: rundown.currentPartInstanceId,
				currentPartInstanceId: takePartInstance._id,
				holdState: !rundown.holdState || rundown.holdState === RundownHoldState.COMPLETE ? RundownHoldState.NONE : rundown.holdState + 1,
			}
			ps.push(asyncCollectionUpdate(Rundowns, rundown._id, {
				$set: m
			}))

			let partM: Mongo.Modifier<PartInstance> = {
				$set: {
					'timings.take': now,
					'timings.playOffset': timeOffset || 0
				}
			}
			if (previousPartEndState) {
				partM['$set']!.previousPartEndState = previousPartEndState
			} else {
				partM['$unset'] = {
					previousPartEndState: 1
				}
			}
			ps.push(asyncCollectionUpdate(PartInstances, takePartInstance._id, partM))
			if (m.previousPartInstanceId) {
				ps.push(asyncCollectionUpdate(PartInstances, m.previousPartInstanceId, {
					$set: {
						'timings.takeOut': now,
					}
				}))
			}
			rundown = _.extend(rundown, m) as Rundown

			libSetNextPart(rundown, nextPart)
			waitForPromiseAll(ps)
			ps = []

			// Setup the parts for the HOLD we are starting
			if (m.previousPartInstanceId && m.holdState === RundownHoldState.ACTIVE) {
				const previousPartInstance = rundownData.partInstancesMap[m.previousPartInstanceId]
				if (!previousPartInstance) throw new Meteor.Error(404, 'previousPart not found!')

				// Make a copy of any item which is flagged as an 'infinite' extension
				const itemsToCopy = previousPartInstance.part.getAllPieces().filter(i => i.extendOnHold)
				itemsToCopy.forEach(piece => {
					// mark current one as infinite
					piece.infiniteId = piece._id
					piece.infiniteMode = PieceLifespan.OutOnNextPart
					ps.push(asyncCollectionUpdate(Pieces, piece._id, {
						$set: {
							infiniteMode: PieceLifespan.OutOnNextPart,
							infiniteId: piece._id,
						}
					}))

					// make the extension
					const newPiece: Piece = clone(piece)
					newPiece.partId = takePartInstance.part._id
					newPiece.enable = { start: 0 }
					const content = newPiece.content as VTContent
					if (content.fileName && content.sourceDuration && piece.startedPlayback) {
						content.seek = Math.min(content.sourceDuration, getCurrentTime() - piece.startedPlayback)
					}
					newPiece.dynamicallyInserted = true
					newPiece._id = piece._id + '_hold'

					// This gets deleted once the nextpart is activated, so it doesnt linger for long
					ps.push(asyncCollectionUpsert(Pieces, newPiece._id, newPiece))
					rundownData.pieces.push(newPiece) // update the local collection

				})
			}
			waitForPromiseAll(ps)
			afterTake(rundownData, takePartInstance, timeOffset)

			// Last:
			const takeDoneTime = getCurrentTime()
			Meteor.defer(() => {
				PartInstances.update(takePartInstance._id, {
					$set: {
						'timings.takeDone': takeDoneTime
					}
				})
				// let bp = getBlueprintOfRundown(rundown)
				if (firstTake) {
					if (blueprint.onRundownFirstTake) {
						waitForPromise(
							Promise.resolve(blueprint.onRundownFirstTake(new PartEventContext(rundown, undefined, takePartInstance)))
							.catch(logger.error)
						)
					}
				}

				if (blueprint.onPostTake) {
					waitForPromise(
						Promise.resolve(blueprint.onPostTake(new PartEventContext(rundown, undefined, takePartInstance)))
						.catch(logger.error)
					)
				}
			})

			return ClientAPI.responseSuccess()
		})
	}
	export function setNextPart (
		rundownId: string,
		nextPartId: string | null,
		setManually?: boolean,
		nextTimeOffset?: number | undefined
	): ClientAPI.ClientResponse {
		check(rundownId, String)
		if (nextPartId) check(nextPartId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			setNextPartInner(rundown, nextPartId, setManually, nextTimeOffset)

			return ClientAPI.responseSuccess()
		})
	}
	export function setNextPartInner (
		rundown: Rundown,
		nextPartId: string | DBPart | null,
		setManually?: boolean,
		nextTimeOffset?: number | undefined
	) {
		if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundown._id}" is not active!`)

		if (rundown.holdState && rundown.holdState !== RundownHoldState.COMPLETE) throw new Meteor.Error(501, `Rundown "${rundown._id}" cannot change next during hold!`)

		let nextPart: DBPart | null = null
		if (nextPartId) {
			if (_.isString(nextPartId)) {
				nextPart = Parts.findOne(nextPartId) || null
			} else if (_.isObject(nextPartId)) {
				nextPart = nextPartId
			}
			if (!nextPart) throw new Meteor.Error(404, `Part "${nextPartId}" not found!`)
		}

		libSetNextPart(rundown, nextPart, setManually, nextTimeOffset)

		// remove old auto-next from timeline, and add new one
		updateTimeline(rundown.studioId)
	}
	export function moveNextPart (
		rundownId: string,
		horisontalDelta: number,
		verticalDelta: number,
		setManually: boolean
	): string | null {
		check(rundownId, String)
		check(horisontalDelta, Number)
		check(verticalDelta, Number)

		if (!horisontalDelta && !verticalDelta) throw new Meteor.Error(402, `rundownMoveNext: invalid delta: (${horisontalDelta}, ${verticalDelta})`)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			return moveNextPartInner(
				rundownId,
				horisontalDelta,
				verticalDelta,
				setManually
			)
		})
	}
	function moveNextPartInner (
		rundownId: string,
		horisontalDelta: number,
		verticalDelta: number,
		setManually: boolean,
		nextPartId0?: string
	): string | null {

		const rundown = Rundowns.findOne(rundownId)
		if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
		if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundownId}" is not active!`)

		if (rundown.holdState && rundown.holdState !== RundownHoldState.COMPLETE) throw new Meteor.Error(501, `Rundown "${rundownId}" cannot change next during hold!`)

		let currentNextPart: Part
		if (nextPartId0) {
			const nextPart = Parts.findOne(nextPartId0)
			if (!nextPart) throw new Meteor.Error(404, `Part "${nextPartId0}" not found!`)
			currentNextPart = nextPart
		} else {
			const nextPartIdTmp = rundown.nextPartInstanceId || rundown.currentPartInstanceId
			if (!nextPartIdTmp) throw new Meteor.Error(501, `Rundown "${rundownId}" has no next and no current part!`)

			const nextPart = PartInstances.findOne(nextPartIdTmp)
			if (!nextPart) throw new Meteor.Error(501, `Rundown "${rundownId}" has an invalid next or current part!`)
			currentNextPart = nextPart.part
		}

		let currentNextSegment = Segments.findOne(currentNextPart.segmentId) as Segment
		if (!currentNextSegment) throw new Meteor.Error(404, `Segment "${currentNextPart.segmentId}" not found!`)

		let parts = rundown.getParts()
		let segments = rundown.getSegments()

		let partIndex: number = -1
		_.find(parts, (part, i) => {
			if (part._id === currentNextPart._id) {
				partIndex = i
				return true
			}
		})
		let segmentIndex: number = -1
		_.find(segments, (s, i) => {
			if (s._id === currentNextSegment._id) {
				segmentIndex = i
				return true
			}
		})
		if (partIndex === -1) throw new Meteor.Error(404, `Part not found in list of parts!`)
		if (segmentIndex === -1) throw new Meteor.Error(404, `Segment not found in list of segments!`)
		if (verticalDelta !== 0) {
			segmentIndex += verticalDelta

			let segment = segments[segmentIndex]

			if (!segment) throw new Meteor.Error(404, `No Segment found!`)

			let partsInSegment = segment.getParts()
			let part = _.first(partsInSegment) as Part
			if (!part) throw new Meteor.Error(404, `No Parts in segment "${segment._id}"!`)

			partIndex = -1
			_.find(parts, (p, i) => {
				if (p._id === part._id) {
					partIndex = i
					return true
				}
			})
			if (partIndex === -1) throw new Meteor.Error(404, `Part (from segment) not found in list of parts!`)
		}
		partIndex += horisontalDelta

		partIndex = Math.max(0, Math.min(parts.length - 1, partIndex))

		let part = parts[partIndex]
		if (!part) throw new Meteor.Error(501, `Part index ${partIndex} not found in list of parts!`)

		if ((part._id === rundown.currentPartId && !nextPartId0) || part.invalid) {
			// Whoops, we're not allowed to next to that.
			// Skip it, then (ie run the whole thing again)
			if (part._id !== nextPartId0) {
				return moveNextPartInner(rundownId, horisontalDelta, verticalDelta, setManually, part._id)
			} else {
				// Calling ourselves again at this point would result in an infinite loop
				// There probably isn't any Part available to Next then...
				setNextPartInner(rundown, null, setManually)
				return null
			}
		} else {
			setNextPartInner(rundown, part, setManually)
			return part._id
		}
	}
	export function activateHold (rundownId: string) {
		check(rundownId, String)
		logger.debug('rundownActivateHold')

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			if (!rundown.currentPartInstanceId) throw new Meteor.Error(400, `Rundown "${rundownId}" no current part!`)
			if (!rundown.nextPartInstanceId) throw new Meteor.Error(400, `Rundown "${rundownId}" no next part!`)

			const currentPartInstance = PartInstances.findOne({ _id: rundown.currentPartInstanceId })
			if (!currentPartInstance) throw new Meteor.Error(404, `PartInstance "${rundown.currentPartInstanceId}" not found!`)
			const nextPartInstance = PartInstances.findOne({ _id: rundown.nextPartInstanceId })
			if (!nextPartInstance) throw new Meteor.Error(404, `PartInstance "${rundown.nextPartInstanceId}" not found!`)

			if (currentPartInstance.part.holdMode !== PartHoldMode.FROM || nextPartInstance.part.holdMode !== PartHoldMode.TO) {
				throw new Meteor.Error(400, `Rundown "${rundownId}" incompatible pair of HoldMode!`)
			}

			if (rundown.holdState) {
				throw new Meteor.Error(400, `Rundown "${rundownId}" already doing a hold!`)
			}

			Rundowns.update(rundownId, { $set: { holdState: RundownHoldState.PENDING } })

			updateTimeline(rundown.studioId)

			return ClientAPI.responseSuccess()
		})
	}
	export function deactivateHold (rundownId: string) {
		check(rundownId, String)
		logger.debug('rundownDeactivateHold')

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			if (rundown.holdState !== RundownHoldState.PENDING) throw new Meteor.Error(400, `Rundown "${rundownId}" is not pending a hold!`)

			Rundowns.update(rundownId, { $set: { holdState: RundownHoldState.NONE } })

			updateTimeline(rundown.studioId)

			return ClientAPI.responseSuccess()
		})
	}
	export function disableNextPiece (rundownId: string, undo?: boolean) {
		check(rundownId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.currentPartInstanceId) throw new Meteor.Error(401, `No current part!`)

			const studio = rundown.getStudio()
			const showStyleBase = rundown.getShowStyleBase()

			const currentPartInstance = PartInstances.findOne(rundown.currentPartInstanceId)
			if (!currentPartInstance) throw new Meteor.Error(404, `PartInstance "${rundown.currentPartInstanceId}" not found!`)

			const nextPartInstance = (rundown.nextPartInstanceId ? PartInstances.findOne(rundown.nextPartInstanceId) : undefined)

			const currentSement = Segments.findOne(currentPartInstance.segmentId)
			if (!currentSement) throw new Meteor.Error(404, `Segment "${currentPartInstance.segmentId}" not found!`)

			// TODO - this will need to consider instances
			let o = getResolvedSegment(showStyleBase, rundown, currentSement)

			// @ts-ignore stringify
			// logger.info(o)
			// logger.info(JSON.stringify(o, '', 2))

			let allowedSourceLayers: {[layerId: string]: ISourceLayerExtended} = {}
			_.each(o.segmentExtended.sourceLayers, (sourceLayer: ISourceLayerExtended) => {
				if (sourceLayer.allowDisable) allowedSourceLayers[sourceLayer._id] = sourceLayer
			})

			// logger.info('allowedSourceLayers', allowedSourceLayers)

			// logger.info('nowInPart', nowInPart)
			// logger.info('filteredPieces', filteredPieces)
			let getNextPiece = (part: Part, undo?: boolean) => {
				// Find next piece to disable

				let nowInPart = 0
				if (
					part.startedPlayback &&
					part.timings &&
					part.timings.startedPlayback
				) {
					let lastStartedPlayback = _.last(part.timings.startedPlayback)

					if (lastStartedPlayback) {
						nowInPart = getCurrentTime() - lastStartedPlayback
					}
				}

				let pieces: Array<PieceResolved> = getOrderedPiece(part)

				let findLast: boolean = !!undo

				let filteredPieces = _.sortBy(
					_.filter(pieces, (piece: PieceResolved) => {
						let sourceLayer = allowedSourceLayers[piece.sourceLayerId]
						if (sourceLayer && sourceLayer.allowDisable && !piece.virtual) return true
						return false
					}),
					(piece: PieceResolved) => {
						let sourceLayer = allowedSourceLayers[piece.sourceLayerId]
						return sourceLayer._rank || -9999
					}
				)
				if (findLast) filteredPieces.reverse()

				let nextPiece: PieceResolved | undefined = _.find(filteredPieces, (piece) => {
					logger.info('piece.resolvedStart', piece.resolvedStart)
					return (
						piece.resolvedStart >= nowInPart &&
						(
							(
								!undo &&
								!piece.disabled
							) || (
								undo &&
								piece.disabled
							)
						)
					)
				})
				return nextPiece
			}

			if (nextPart) {
				// pretend that the next part never has played (even if it has)
				nextPart.startedPlayback = false
			}

			let sls = [
				currentPart,
				nextPart // If not found in currently playing part, let's look in the next one:
			]
			if (undo) sls.reverse()

			let nextPiece: PieceResolved | undefined

			_.each(sls, (part) => {
				if (part && !nextPiece) {
					nextPiece = getNextPiece(part, undo)
				}
			})

			if (nextPiece) {
				logger.info((undo ? 'Disabling' : 'Enabling') + ' next piece ' + nextPiece._id)
				Pieces.update(nextPiece._id, {$set: {
					disabled: !undo
				}})
				updateTimeline(studio._id)

				return ClientAPI.responseSuccess()
			} else {
				return ClientAPI.responseError('Found no future pieces')
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Piece has started playing
	 */
	export function onPiecePlaybackStarted (rundownId: string, pieceId: string, startedPlayback: Time) {
		check(rundownId, String)
		check(pieceId, String)
		check(startedPlayback, Number)

		// TODO - confirm this is correct
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when an auto-next event occurs
			const piece = Pieces.findOne({
				_id: pieceId,
				rundownId: rundownId
			})
			if (!piece) throw new Meteor.Error(404, `Piece "${pieceId}" in rundown "${rundownId}" not found!`)

			const isPlaying: boolean = !!(
				piece.startedPlayback &&
				!piece.stoppedPlayback
			)
			if (!isPlaying) {
				logger.info(`Playout reports piece "${pieceId}" has started playback on timestamp ${(new Date(startedPlayback)).toISOString()}`)

				reportPieceHasStarted(piece, startedPlayback)

				// We don't need to bother with an updateTimeline(), as this hasn't changed anything, but lets us accurately add started items when reevaluating
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Piece has stopped playing
	 */
	export function onPiecePlaybackStopped (rundownId: string, pieceId: string, stoppedPlayback: Time) {
		check(rundownId, String)
		check(pieceId, String)
		check(stoppedPlayback, Number)

		// TODO - confirm this is correct
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when an auto-next event occurs
			const piece = Pieces.findOne({
				_id: pieceId,
				rundownId: rundownId
			})
			if (!piece) throw new Meteor.Error(404, `Piece "${pieceId}" in rundown "${rundownId}" not found!`)

			const isPlaying: boolean = !!(
				piece.startedPlayback &&
				!piece.stoppedPlayback
			)
			if (isPlaying) {
				logger.info(`Playout reports piece "${pieceId}" has stopped playback on timestamp ${(new Date(stoppedPlayback)).toISOString()}`)

				reportPieceHasStopped(piece, stoppedPlayback)
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Part has started playing
	 */
	export function onPartPlaybackStarted (rundownId: string, partInstanceId: string, startedPlayback: Time) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(startedPlayback, Number)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when a part starts playing (like when an auto-next event occurs, or a manual next)

			const playingPartInstance = PartInstances.findOne({
				_id: partInstanceId,
				rundownId: rundownId
			})

			if (playingPartInstance) {
				// make sure we don't run multiple times, even if TSR calls us multiple times

				const isPlaying = (
					playingPartInstance.timings.startedPlayback &&
					!playingPartInstance.timings.stoppedPlayback
				)
				if (!isPlaying) {
					logger.info(`Playout reports partInstance "${partInstanceId}" has started playback on timestamp ${(new Date(startedPlayback)).toISOString()}`)

					let rundown = Rundowns.findOne(rundownId) as Rundown
					if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
					if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundownId}" is not active!`)

					const currentPartInstance = (
						rundown.currentPartInstanceId ?
						PartInstances.findOne(rundown.currentPartInstanceId) :
						null
					)

					if (rundown.currentPartInstanceId === partInstanceId) {
						// this is the current part, it has just started playback
						if (rundown.previousPartInstanceId) {
							const prevPartInstance = PartInstances.findOne(rundown.previousPartInstanceId)

							if (!prevPartInstance) {
								// We couldn't find the previous part: this is not a critical issue, but is clearly is a symptom of a larger issue
								logger.error(`Previous partInstance "${rundown.previousPartInstanceId}" on rundown "${rundownId}" could not be found.`)
							} else if (!prevPartInstance.duration) {
								onPartHasStoppedPlaying(prevPartInstance, startedPlayback)
							}
						}

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played
					} else if (rundown.nextPartInstanceId === partInstanceId) {
						// this is the next part, clearly an autoNext has taken place
						if (rundown.currentPartInstanceId) {
							if (!currentPartInstance) {
								// We couldn't find the previous part: this is not a critical issue, but is clearly is a symptom of a larger issue
								logger.error(`Previous partInstance "${rundown.currentPartInstanceId}" on rundown "${rundownId}" could not be found.`)
							} else if (!currentPartInstance.duration) {
								onPartHasStoppedPlaying(currentPartInstance, startedPlayback)
							}
						}

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played

						let partsAfter = rundown.getParts({
							_rank: {
								$gt: playingPart._rank,
							},
							_id: { $ne: playingPart._id }
						}, {
							limit: 1
						})

						let nextPart: Part | null = _.first(partsAfter) || null

						const rundownChange = literal<Partial<Rundown>>({
							previousPartInstanceId: rundown.currentPartInstanceId,
							currentPartInstanceId: playingPartInstance._id,
							holdState: RundownHoldState.NONE,
						})

						Rundowns.update(rundown._id, {
							$set: rundownChange
						})
						rundown = _.extend(rundown, rundownChange) as Rundown

						libSetNextPart(rundown, nextPart)
					} else {
						// a part is being played that has not been selected for playback by Core
						// show must go on, so find next part and update the Rundown, but log an error
						let partsAfter = rundown.getParts({
							_rank: {
								$gt: playingPart._rank,
							},
							_id: { $ne: playingPart._id }
						})

						let nextPart: Part | null = partsAfter[0] || null

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played

						const rundownChange = literal<Partial<Rundown>>({
							previousPartInstanceId: null,
							currentPartInstanceId: playingPartInstance._id,
						})

						Rundowns.update(rundown._id, {
							$set: rundownChange
						})
						rundown = _.extend(rundown, rundownChange) as Rundown
						libSetNextPart(rundown, nextPart)

						logger.error(`PartInstance "${playingPartInstance._id}" has started playback by the playout gateway, but has not been selected for playback!`)
					}

					reportPartHasStarted(playingPartInstance, startedPlayback)

					const rundownData = rundown.fetchAllData()

					afterTake(rundownData, playingPartInstance)
				}
			} else {
				throw new Meteor.Error(404, `PartInstance "${partInstanceId}" in rundown "${rundownId}" not found!`)
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Part has stopped playing
	 */
	export function onPartPlaybackStopped (rundownId: string, partInstanceId: string, stoppedPlayback: Time) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(stoppedPlayback, Number)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when a part stops playing (like when an auto-next event occurs, or a manual next)

			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

			const partInstance = PartInstances.findOne({
				_id: partInstanceId,
				rundownId: rundownId
			})

			if (partInstance) {
				// make sure we don't run multiple times, even if TSR calls us multiple times

				const isPlaying = (
					partInstance.timings.startedPlayback &&
					!partInstance.timings.stoppedPlayback
				)
				if (isPlaying) {
					logger.info(`Playout reports partInstance "${partInstanceId}" has stopped playback on timestamp ${(new Date(stoppedPlayback)).toISOString()}`)

					reportPartHasStopped(partInstance, stoppedPlayback)
				}
			} else {
				throw new Meteor.Error(404, `PartInstance "${partInstanceId}" in rundown "${rundownId}" not found!`)
			}
		})
	}
	/**
	 * Make a copy of a piece and start playing it now
	 */
	export function pieceTakeNow (rundownId: string, partInstanceId: string, pieceId: string) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(pieceId, String)

		return ServerPlayoutAdLibAPI.pieceTakeNow(rundownId, partInstanceId, pieceId)
	}
	export function segmentAdLibPieceStart (rundownId: string, partInstanceId: string, adLibPieceId: string, queue: boolean) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(adLibPieceId, String)

		return ServerPlayoutAdLibAPI.segmentAdLibPieceStart(rundownId, partInstanceId, adLibPieceId, queue)
	}
	export function rundownBaselineAdLibPieceStart (rundownId: string, partInstanceId: string, baselineAdLibPieceId: string, queue: boolean) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(baselineAdLibPieceId, String)

		return ServerPlayoutAdLibAPI.rundownBaselineAdLibPieceStart(rundownId, partInstanceId, baselineAdLibPieceId, queue)
	}
	export function stopAdLibPiece (rundownId: string, partInstanceId: string, pieceId: string) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(pieceId, String)

		return ServerPlayoutAdLibAPI.stopAdLibPiece(rundownId, partInstanceId, pieceId)
	}
	export function sourceLayerStickyPieceStart (rundownId: string, sourceLayerId: string) {
		check(rundownId, String)
		check(sourceLayerId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Pieces can be only manipulated in an active rundown!`)
			if (!rundown.currentPartInstanceId) throw new Meteor.Error(400, `A part needs to be active to place a sticky item`)

			let showStyleBase = rundown.getShowStyleBase()

			const sourceLayer = showStyleBase.sourceLayers.find(i => i._id === sourceLayerId)
			if (!sourceLayer) throw new Meteor.Error(404, `Source layer "${sourceLayerId}" not found!`)
			if (!sourceLayer.isSticky) throw new Meteor.Error(400, `Only sticky layers can be restarted. "${sourceLayerId}" is not sticky.`)

			const lastPieces = Pieces.find({
				rundownId: rundown._id,
				sourceLayerId: sourceLayer._id,
				startedPlayback: {
					$exists: true
				}
			}, {
				sort: {
					startedPlayback: -1
				},
				limit: 1
			}).fetch()

			if (lastPieces.length > 0) {
				const currentPartInstance = PartInstances.findOne(rundown.currentPartInstanceId)
				if (!currentPartInstance) throw new Meteor.Error(501, `Current PartInstance "${rundown.currentPartInstanceId}" could not be found.`)

				const lastPiece = convertPieceToAdLibPiece(lastPieces[0])
				const newAdLibPiece = convertAdLibToPiece(lastPiece, currentPartInstance.part, false) // TODO eww..

				Pieces.insert(newAdLibPiece)

				// logger.debug('adLibItemStart', newPiece)

				cropInfinitesOnLayer(rundown, currentPart, newAdLibPiece)
				stopInfinitesRunningOnLayer(rundown, currentPart, newAdLibPiece.sourceLayerId)

				updateTimeline(rundown.studioId)
			}
		})
	}
	export function sourceLayerOnPartStop (rundownId: string, partInstanceId: string, sourceLayerId: string) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(sourceLayerId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Pieces can be only manipulated in an active rundown!`)
			const partInstance = PartInstances.findOne({
				_id: partInstanceId,
				rundownId: rundownId
			})
			if (!partInstance) throw new Meteor.Error(404, `Part "${partInstanceId}" not found!`)
			if (rundown.currentPartInstanceId !== partInstance._id) throw new Meteor.Error(403, `Pieces can be only manipulated in a current part!`)
			if (!partInstance.timings.startedPlayback) throw new Meteor.Error(405, `Part "${partInstanceId}" has yet to start playback!`)

			const now = getCurrentTime()
			const relativeNow = now - partInstance.timings.startedPlayback
			const orderedPieces = getResolvedPieces(part)

			orderedPieces.forEach((piece) => {
				if (piece.sourceLayerId === sourceLayerId) {
					if (!piece.userDuration) {
						let newExpectedDuration: number | undefined = undefined

						if (piece.infiniteId && piece.infiniteId !== piece._id && partInstance) {
							const partStarted = partInstance.timings.startedPlayback
							if (partStarted) {
								newExpectedDuration = now - partStarted
							}
						} else if (
							piece.startedPlayback && // currently playing
							_.isNumber(piece.enable.start) &&
							(piece.enable.start || 0) < relativeNow && // is relative, and has started
							!piece.stoppedPlayback // and not yet stopped
						) {
							newExpectedDuration = now - piece.startedPlayback
						}

						if (newExpectedDuration !== undefined) {
							console.log(`Cropping piece "${piece._id}" at ${newExpectedDuration}`)

							Pieces.update({
								_id: piece._id
							}, {
								$set: {
									userDuration: {
										duration: newExpectedDuration
									}
								}
							})
						}
					}
				}
			})

			updateSourceLayerInfinitesAfterPart(rundown, part)

			updateTimeline(rundown.studioId)
		})
	}
	export function rundownTogglePartArgument (rundownId: string, partInstanceId: string, property: string, value: string) {
		check(rundownId, String)
		check(partInstanceId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.holdState === RundownHoldState.ACTIVE || rundown.holdState === RundownHoldState.PENDING) {
				throw new Meteor.Error(403, `Part Arguments can not be toggled when hold is used!`)
			}

			let partInstance = PartInstances.findOne(partInstanceId)
			if (!partInstance) throw new Meteor.Error(404, `PartInstance "${partInstanceId}" not found!`)

			const rArguments = partInstance.runtimeArguments || {}

			if (rArguments[property] === value) {
				// unset property
				const mUnset: any = {}
				mUnset['runtimeArguments.' + property] = 1
				PartInstances.update(partInstance._id, {$unset: mUnset, $set: {
					dirty: true
				}})
			} else {
				// set property
				const mSet: any = {}
				mSet['runtimeArguments.' + property] = value
				mSet.dirty = true
				PartInstances.update(partInstance._id, { $set: mSet })
			}

			partInstance = PartInstances.findOne(partInstanceId)

			if (!partInstance) throw new Meteor.Error(404, `PartInstance "${partInstanceId}" not found!`)

			refreshPart(rundown, partInstance)

			// Only take time to update the timeline if there's a point to do it
			if (rundown.active) {
				// If this part is rundown's next, check if current part has autoNext
				if ((rundown.nextPartInstanceId === partInstance._id) && rundown.currentPartInstanceId) {
					const currentPartInstance = PartInstances.findOne(rundown.currentPartInstanceId)
					if (currentPartInstance && currentPartInstance.part.autoNext) {
						updateTimeline(rundown.studioId)
					}
				// If this is rundown's current part, update immediately
				} else if (rundown.currentPartInstanceId === partInstance._id) {
					updateTimeline(rundown.studioId)
				}
			}
			return ClientAPI.responseSuccess()
		})
	}
	/**
	 * Called from Playout-gateway when the trigger-time of a timeline object has updated
	 * ( typically when using the "now"-feature )
	 */
	export function timelineTriggerTimeUpdateCallback (studioId: string, timelineObj: TimelineObjGeneric, time: number) {
		check(timelineObj, Object)
		check(time, Number)

		// TODO - this is a destructive action... It needs to either backup the original, or only run on dynamically inserted
		if (timelineObj.metadata && timelineObj.metadata.pieceId) {
			logger.debug('Update piece: ', timelineObj.metadata.pieceId, (new Date(time)).toTimeString())
			Pieces.update({
				_id: timelineObj.metadata.pieceId
			}, {
				$set: {
					'enable.start': time
				}
			})
		}
	}
	export function updateStudioBaseline (studioId: string) {
		check(studioId, String)

		// TODO - should there be a studio lock for activate/deactivate/this?

		const activeRundowns = areThereActiveRundownsInStudio(studioId)
		if (activeRundowns.length === 0) {
			// This is only run when there is no rundown active in the studio
			updateTimeline(studioId)
		}

		return shouldUpdateStudioBaseline(studioId)
	}
	export function shouldUpdateStudioBaseline (studioId: string) {
		check(studioId, String)

		const studio = Studios.findOne(studioId)
		if (!studio) throw new Meteor.Error(404, `Studio "${studioId}" not found!`)

		const activeRundowns = areThereActiveRundownsInStudio(studio._id)

		if (activeRundowns.length === 0) {
			const markerId = `${studio._id}_baseline_version`
			const markerObject = Timeline.findOne(markerId)
			if (!markerObject) return 'noBaseline'

			const versionsContent = (markerObject.metadata || {}).versions || {}

			if (versionsContent.core !== PackageInfo.version) return 'coreVersion'

			if (versionsContent.studio !== (studio._rundownVersionHash || 0)) return 'studio'

			if (versionsContent.blueprintId !== studio.blueprintId) return 'blueprintId'
			if (studio.blueprintId) {
				const blueprint = Blueprints.findOne(studio.blueprintId)
				if (!blueprint) return 'blueprintUnknown'
				if (versionsContent.blueprintVersion !== (blueprint.blueprintVersion || 0)) return 'blueprintVersion'
			}
		}

		return false
	}
}

function beforeTake (rundownData: PlayoutRundownData, currentPartInstance: PartInstance | null, nextPartInstance: PartInstance) {
	if (currentPartInstance) {
		const adjacentPart = _.find(rundownData.parts, (part) => {
			return (
				part.segmentId === currentPart.segmentId &&
				part._rank > currentPart._rank
			)
		})
		if (!adjacentPart || adjacentPart._id !== nextPart._id) {
			// adjacent Part isn't the next part, do not overflow
			return
		}
		let ps: Array<Promise<any>> = []
		const currentPieces = currentPartInstance.part.getAllPieces()
		currentPieces.forEach((piece) => {
			if (piece.overflows && typeof piece.enable.duration === 'number' && piece.enable.duration > 0 && piece.playoutDuration === undefined && piece.userDuration === undefined) {
				// Subtract the amount played from the duration
				const remainingDuration = Math.max(0, piece.enable.duration - ((piece.startedPlayback || currentPartInstance.timings.startedPlayback || getCurrentTime()) - getCurrentTime()))

				if (remainingDuration > 0) {
					// Clone an overflowing piece
					let overflowedItem = literal<Piece>({
						..._.omit(piece, 'startedPlayback', 'duration', 'overflows'),
						_id: Random.id(),
						partId: nextPartInstance.part._id, // TODO eww
						enable: {
							start: 0,
							duration: remainingDuration,
						},
						dynamicallyInserted: true,
						continuesRefId: piece._id,
					})

					ps.push(asyncCollectionInsert(Pieces, overflowedItem))
					rundownData.pieces.push(overflowedItem) // update the cache
				}
			}
		})
		waitForPromiseAll(ps)
	}
}

function afterTake (
	rundownData: PlayoutRundownData,
	takePartInstance: PartInstance,
	timeOffset: number | null = null
) {
	// This function should be called at the end of a "take" event (when the Parts have been updated)

	let forceNowTime: number | undefined = undefined
	if (timeOffset) {
		forceNowTime = getCurrentTime() - timeOffset
	}
	// or after a new part has started playing
	updateTimeline(rundownData.rundown.studioId, forceNowTime, rundownData)

	// defer these so that the playout gateway has the chance to learn about the changes
	Meteor.setTimeout(() => {
		if (takePartInstance.part.shouldNotifyCurrentPlayingPart) {
			IngestActions.notifyCurrentPlayingPart(rundownData.rundown, takePartInstance.part)

		}
	}, 40)
}

function setRundownStartedPlayback (rundown: Rundown, startedPlayback: Time) {
	if (!rundown.startedPlayback) { // Set startedPlayback on the rundown if this is the first item to be played
		reportRundownHasStarted(rundown, startedPlayback)
	}
}

interface UpdateTimelineFromIngestDataTimeout {
	timeout?: number
	changedSegments: string[]
}
let updateTimelineFromIngestDataTimeouts: {
	[id: string]: UpdateTimelineFromIngestDataTimeout
} = {}
export function triggerUpdateTimelineAfterIngestData (rundownId: string, changedSegments: Array<string>) {
	// Lock behind a timeout, so it doesnt get executed loads when importing a rundown or there are large changes
	let data: UpdateTimelineFromIngestDataTimeout = updateTimelineFromIngestDataTimeouts[rundownId]
	if (data) {
		if (data.timeout) Meteor.clearTimeout(data.timeout)
		data.changedSegments = data.changedSegments.concat(changedSegments)
	} else {
		data = {
			changedSegments: changedSegments
		}
	}

	data.timeout = Meteor.setTimeout(() => {
		delete updateTimelineFromIngestDataTimeouts[rundownId]

		// infinite items only need to be recalculated for those after where the edit was made (including the edited line)
		let prevPart: Part | undefined
		if (data.changedSegments) {
			const firstSegment = Segments.findOne({
				rundownId: rundownId,
				_id: { $in: data.changedSegments }
			})
			if (firstSegment) {
				prevPart = getPreviousPartForSegment(rundownId, firstSegment)
			}
		}

		const rundown = Rundowns.findOne(rundownId)
		if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)

		// TODO - test the input data for this
		updateSourceLayerInfinitesAfterPart(rundown, prevPart, true)

		if (rundown.active) {
			updateTimeline(rundown.studioId)
		}
	}, 1000)

	updateTimelineFromIngestDataTimeouts[rundownId] = data
}
