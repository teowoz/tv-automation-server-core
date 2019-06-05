
/* tslint:disable:no-use-before-declare */
import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import { Rundowns, Rundown, RundownHoldState, RundownData, DBRundown } from '../../../lib/collections/Rundowns'
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
	literal} from '../../../lib/lib'
import { Timeline, getTimelineId, TimelineObjGeneric } from '../../../lib/collections/Timeline'
import { Segments, Segment } from '../../../lib/collections/Segments'
import { Random } from 'meteor/random'
import * as _ from 'underscore'
import { logger } from '../../logging'
import {
	PieceLifespan,
	PartHoldMode,
	VTContent
} from 'tv-automation-sofie-blueprints-integration'
import { Studios } from '../../../lib/collections/Studios'
import { getResolvedSegment, ISourceLayerExtended } from '../../../lib/Rundown'
import { ClientAPI } from '../../../lib/api/client'
import {
	reportRundownHasStarted,
	reportPartInstanceHasStarted,
	reportPieceInstanceHasStarted,
	reportPartInstanceHasStopped,
	reportPieceInstanceHasStopped
} from '../asRunLog'
import { Blueprints } from '../../../lib/collections/Blueprints'
import { getBlueprintOfRundown } from '../blueprints/cache'
import { PartEventContext } from '../blueprints/context'
import { IngestActions } from '../ingest/actions'
import { updateTimeline } from './timeline'
import {
	resetRundown as libResetRundown,
	setNextPart as libSetNextPart,
	onPartInstanceHasStoppedPlaying,
	refreshPart,
	getPreviousPartForSegment
} from './lib'
import {
	prepareStudioForBroadcast,
	activateRundown as libActivateRundown,
	deactivateRundown as libDeactivateRundown
} from './actions'
import { PieceResolved, getOrderedPiece, getResolvedPieces, convertAdLibToPiece, convertPieceToAdLibPiece } from './pieces'
import { PackageInfo } from '../../coreSystem'
import { areThereActiveRundownsInStudio } from './studio'
import { updateSourceLayerInfinitesAfterPart, cropInfinitesOnLayer, stopInfinitesRunningOnLayer } from './infinites'
import { rundownSyncFunction, RundownSyncFunctionPriority } from '../ingest/rundownInput'
import { ServerPlayoutAdLibAPI } from './adlib'
import { PartInstances, PartInstance } from '../../../lib/collections/PartInstances'
import { PieceInstances, PieceInstance } from '../../../lib/collections/PieceInstances'
import { UpdateNext } from '../ingest/mosDevice/updateNext';

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
	export function resetAndActivateRundown (rundownId: string) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.active && !rundown.rehearsal) throw new Meteor.Error(402, `rundownResetAndActivate cannot be run when active!`)

			libResetRundown(rundown)

			return libActivateRundown(rundown, false) // Activate rundown
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
			if (!rundown.nextPartInstanceId) throw new Meteor.Error(500, 'nextPartId is not set!')

			let timeOffset: number | null = rundown.nextTimeOffset || null

			let firstTake = !rundown.startedPlayback
			let rundownData = rundown.fetchRundownInstancesData()

			const currentPartInstance = rundownData.currentPart
			if (currentPartInstance && currentPartInstance.part.transitionDuration) {
				const prevPartInstance = rundownData.previousPart
				const allowTransition = prevPartInstance && !prevPartInstance.part.disableOutTransition

				// If there was a transition from the previous Part, then ensure that has finished before another take is permitted
				if (allowTransition) {
					const start = currentPartInstance.part.startedPlayback
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
				Rundowns.update(rundown._id, {
					$set: {
						holdState: RundownHoldState.COMPLETE
					}
				})

				if (rundown.currentPartInstanceId) {
					const currentPartInstance = rundownData.currentPart
					if (!currentPartInstance) throw new Meteor.Error(404, 'currentPart not found!')

					// Remove the current extension line
					PieceInstances.remove({
						partInstanceId: currentPartInstance.part._id,
						extendOnHold: true,
						dynamicallyInserted: true
					})
				}
				if (rundown.previousPartInstanceId) {
					const previousPartInstance = rundownData.previousPart
					if (!previousPartInstance) throw new Meteor.Error(404, 'previousPart not found!')

					// Clear the extended mark on the original
					PieceInstances.update({
						partInstanceId: previousPart.part._id,
						extendOnHold: true,
						dynamicallyInserted: false
					}, {
						$unset: {
							infiniteId: 0,
							infiniteMode: 0,
						}
					}, { multi: true })
				}

				updateTimeline(rundown.studioId)
				return ClientAPI.responseSuccess()
			}
			let pBlueprint = makePromise(() => getBlueprintOfRundown(rundown))

			let previousPartInstance = rundownData.currentPart
			let takePartInstance = rundownData.nextPart
			if (!takePartInstance) throw new Meteor.Error(404, 'takePart not found!')
			// let takeSegment = rundownData.segmentsMap[takePart.segmentId]
			let partAfter = fetchAfter(rundownData.parts, {
				rundownId: rundown._id,
				invalid: { $ne: true }
			}, takePartInstance.part._rank) // TODO - translate rank to ensure correct if part numbers change?

			let nextPart: DBPart | null = partAfter || null

			// beforeTake(rundown, previousPart || null, takePart)
			beforeTake(rundownData, previousPart || null, takePart)

			const { blueprint } = waitForPromise(pBlueprint)
			if (blueprint.onPreTake) {
				try {
					waitForPromise(
						Promise.resolve(blueprint.onPreTake(new PartEventContext(rundown, undefined, takePartInstance.part)))
						.catch(logger.error)
					)
				} catch (e) {
					logger.error(e)
				}
			}

			let ps: Array<Promise<any>> = []
			let m = literal<Partial<DBRundown>>({
				previousPartInstanceId: rundown.currentPartInstanceId,
				currentPartInstanceId: takePartInstance.part._id,
				holdState: !rundown.holdState || rundown.holdState === RundownHoldState.COMPLETE ? RundownHoldState.NONE : rundown.holdState + 1,
			})
			ps.push(asyncCollectionUpdate(Rundowns, rundown._id, {
				$set: m
			}))
			// ps.push(asyncCollectionUpdate(Parts, takePart._id, {
			// 	$push: {
			// 		'timings.take': now,
			// 		'timings.playOffset': timeOffset || 0
			// 	}
			// }))
			if (m.previousPartInstanceId) {
				ps.push(asyncCollectionUpdate(PartInstances, m.previousPartInstanceId, {
					$set: {
						'takeOut': now,
					}
				}))
			}
			rundown = _.extend(rundown, m) as Rundown

			libSetNextPart(rundown, nextPart)
			waitForPromiseAll(ps)

			ps = []

			// Setup the parts for the HOLD we are starting
			if (m.previousPartInstanceId && m.holdState === RundownHoldState.ACTIVE) {
				let previousPartInstance = rundownData.currentPart // Follow the id shuffle
				if (!previousPartInstance) throw new Meteor.Error(404, 'previousPart not found!')

				// Make a copy of any item which is flagged as an 'infinite' extension
				const itemsToCopy = previousPartInstance.pieces.filter(i => i.extendOnHold)
				const takePartInstanceId = takePartInstance.part._id
				itemsToCopy.forEach(piece => {
					// mark current one as infinite
					piece.infiniteId = piece._id
					piece.infiniteMode = PieceLifespan.OutOnNextPart
					ps.push(asyncCollectionUpdate(PieceInstances, piece._id, {
						$set: {
							infiniteMode: PieceLifespan.OutOnNextPart,
							infiniteId: piece._id,
						}
					}))

					// make the extension
					const newPiece = clone(piece) as PieceInstance
					newPiece.partId = takePartInstanceId
					newPiece.enable = { start: 0 }
					const content = newPiece.content as VTContent
					if (content.fileName && content.sourceDuration && piece.startedPlayback) {
						content.seek = Math.min(content.sourceDuration, getCurrentTime() - piece.startedPlayback)
					}
					// newPiece.dynamicallyInserted = true
					newPiece._id = piece._id + '_hold'

					// This gets deleted once the nextpart is activated, so it doesnt linger for long
					ps.push(asyncCollectionUpsert(PieceInstances, newPiece._id, newPiece))
					if (rundownData.nextPart) {
						rundownData.nextPart.pieces.push(newPiece) // update the local collection
					}

				})
			}
			waitForPromiseAll(ps)
			afterTake(rundown, takePartInstance.part, timeOffset)

			// last:
			PartInstances.update(takePartInstance.part._id, {
				$set: {
					takeDone: getCurrentTime()
				}
			})

			const takePartInstance2 = takePartInstance.part
			Meteor.defer(() => {
				// let bp = getBlueprintOfRundown(rundown)
				if (firstTake) {
					if (blueprint.onRundownFirstTake) {
						Promise.resolve(blueprint.onRundownFirstTake(new PartEventContext(rundown, undefined, takePartInstance2)))
						.catch(logger.error)
					}
				}

				if (blueprint.onPostTake) {
					Promise.resolve(blueprint.onPostTake(new PartEventContext(rundown, undefined, takePartInstance2)))
					.catch(logger.error)
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
		setManually: boolean,
		currentNextPartId?: string
	): string {
		check(rundownId, String)
		check(horisontalDelta, Number)
		check(verticalDelta, Number)

		if (!horisontalDelta && !verticalDelta) throw new Meteor.Error(402, `rundownMoveNext: invalid delta: (${horisontalDelta}, ${verticalDelta})`)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundownId}" is not active!`)

			if (rundown.holdState && rundown.holdState !== RundownHoldState.COMPLETE) throw new Meteor.Error(501, `Rundown "${rundownId}" cannot change next during hold!`)

			let currentNextPart: Part = undefined as any
			if (currentNextPartId) {
				currentNextPart = Parts.findOne(currentNextPartId) as Part
			} else {
				if (!rundown.nextPartInstanceId) throw new Meteor.Error(501, `Rundown "${rundownId}" has no next part!`)
				const nextPartInstance = PartInstances.findOne(rundown.nextPartInstanceId)
				if (nextPartInstance) {
					currentNextPart = Parts.findOne(nextPartInstance._id) as Part
				}
			}

			if (!currentNextPart) throw new Meteor.Error(404, `PartInstance "${rundown.nextPartInstanceId}" not found!`)

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
				_.find(parts, (part, i) => {
					if (part._id === part._id) {
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

			const currentPartInstance = rundown.currentPartInstanceId ? PartInstances.findOne(rundown.currentPartInstanceId) : undefined
			if ((currentPartInstance && part._id === currentPartInstance.partId && !currentNextPartId) || part.invalid) {
				// Whoops, we're not allowed to next to that.
				// Skip it, then (ie run the whole thing again)
				return moveNextPart(rundownId, horisontalDelta, verticalDelta, setManually, part._id)
			} else {
				setNextPartInner(rundown, part, setManually)
				return part._id
			}
		})
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
			if (!nextPartInstance) throw new Meteor.Error(404, `Part "${rundown.nextPartInstanceId}" not found!`)

			if (currentPartInstance.holdMode !== PartHoldMode.FROM || nextPartInstance.holdMode !== PartHoldMode.TO) {
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
			let getNextPiece = (part: PartInstance, undo?: boolean) => {
				// Find next piece to disable

				let nowInPart = 0
				if (part.startedPlayback) {
					nowInPart = getCurrentTime() - part.startedPlayback
				}

				let pieces: Array<PieceResolved> = getOrderedPiece(part) // TODO - use partInstances!!

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

			if (nextPartInstance) {
				// pretend that the next part never has played (even if it has)
				nextPartInstance.startedPlayback = undefined
			}

			let sls = [
				currentPartInstance,
				nextPartInstance // If not found in currently playing part, let's look in the next one:
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
	export function onPiecePlaybackStarted (rundownId: string, pieceInstanceId: string, startedPlayback: Time) { // TODO - rename
		check(rundownId, String)
		check(pieceInstanceId, String)
		check(startedPlayback, Number)

		// TODO - confirm this is correct
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when an auto-next event occurs
			const pieceInstance = PieceInstances.findOne({
				_id: pieceInstanceId,
				rundownId: rundownId
			})
			if (!pieceInstance) throw new Meteor.Error(404, `PieceInstance "${pieceInstanceId}" in rundown "${rundownId}" not found!`)

			const isPlaying: boolean = !!(
				pieceInstance.startedPlayback &&
				!pieceInstance.stoppedPlayback
			)
			if (!isPlaying) {
				logger.info(`Playout reports pieceInstance "${pieceInstanceId}" has started playback on timestamp ${(new Date(startedPlayback)).toISOString()}`)

				reportPieceInstanceHasStarted(pieceInstance, startedPlayback)

				// We don't need to bother with an updateTimeline(), as this hasn't changed anything, but lets us accurately add started items when reevaluating
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Piece has stopped playing
	 */
	export function onPiecePlaybackStopped (rundownId: string, pieceInstanceId: string, stoppedPlayback: Time) { // TODO - rename
		check(rundownId, String)
		check(pieceInstanceId, String)
		check(stoppedPlayback, Number)

		// TODO - confirm this is correct
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			// This method is called when an auto-next event occurs
			const pieceInstance = PieceInstances.findOne({
				_id: pieceInstanceId,
				rundownId: rundownId
			})
			if (!piece) throw new Meteor.Error(404, `PieceInstance "${pieceInstanceId}" in rundown "${rundownId}" not found!`)

			const isPlaying: boolean = !!(
				pieceInstance.startedPlayback &&
				!pieceInstance.stoppedPlayback
			)
			if (isPlaying) {
				logger.info(`Playout reports pieceInstance "${pieceInstanceId}" has stopped playback on timestamp ${(new Date(stoppedPlayback)).toISOString()}`)

				reportPieceInstanceHasStopped(pieceInstance, stoppedPlayback)
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Part has started playing
	 */
	export function onPartPlaybackStarted (rundownId: string, partInstanceId: string, startedPlayback: Time) { // TODO - rename
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
					playingPartInstance.startedPlayback &&
					!playingPartInstance.stoppedPlayback
				)
				if (!isPlaying) {
					logger.info(`Playout reports PartInstance "${partInstanceId}" has started playback on timestamp ${(new Date(startedPlayback)).toISOString()}`)

					let rundown = Rundowns.findOne(rundownId)
					if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
					if (!rundown.active) throw new Meteor.Error(501, `Rundown "${rundownId}" is not active!`)

					const currentPartInstance = (rundown.currentPartInstanceId ?
						PartInstances.findOne(rundown.currentPartInstanceId)
						: null
					)

					if (rundown.currentPartInstanceId === partInstanceId) {
						// this is the current part, it has just started playback
						if (rundown.previousPartInstanceId) {
							const prevPartInstance = PartInstances.findOne(rundown.previousPartInstanceId)

							if (!prevPartInstance) {
								// We couldn't find the previous part: this is not a critical issue, but is clearly is a symptom of a larger issue
								logger.error(`Previous PartInstance "${rundown.previousPartInstanceId}" on rundown "${rundownId}" could not be found.`)
							} else if (!prevPartInstance.duration) {
								onPartInstanceHasStoppedPlaying(prevPartInstance, startedPlayback)
							}
						}

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played
					} else if (rundown.nextPartInstanceId === partInstanceId) {
						// this is the next part, clearly an autoNext has taken place
						if (rundown.currentPartInstanceId) {
							// let currentPart = Parts.findOne(rundown.currentPartId)

							if (!currentPartInstance) {
								// We couldn't find the previous part: this is not a critical issue, but is clearly is a symptom of a larger issue
								logger.error(`Previous PartInstance "${rundown.currentPartInstanceId}" on rundown "${rundownId}" could not be found.`)
							} else if (!currentPartInstance.duration) {
								onPartInstanceHasStoppedPlaying(currentPartInstance, startedPlayback)
							}
						}

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played

						const rundownChange = literal<Partial<DBRundown>>({
							previousPartInstanceId: rundown.currentPartInstanceId,
							currentPartInstanceId: playingPartInstance._id,
							holdState: RundownHoldState.NONE,
						})

						Rundowns.update(rundown._id, {
							$set: rundownChange
						})
						rundown = _.extend(rundown, rundownChange) as Rundown

						UpdateNext.ensureNextPartIsValid(rundown)
					} else {
						// a part is being played that has not been selected for playback by Core
						// show must go on, so find next part and update the Rundown, but log an error
						// This sounds impossible to hit now that PartInstances exist, but it could if PG lags behind

						setRundownStartedPlayback(rundown, startedPlayback) // Set startedPlayback on the rundown if this is the first item to be played

						const rundownChange = literal<Partial<DBRundown>>({
							previousPartInstanceId: null,
							currentPartInstanceId: playingPartInstance._id,
						})

						Rundowns.update(rundown._id, {
							$set: rundownChange
						})
						rundown = _.extend(rundown, rundownChange) as Rundown

						UpdateNext.ensureNextPartIsValid(rundown)

						logger.error(`Part "${playingPartInstance._id}" has started playback by the playout gateway, but has not been selected for playback!`)
					}

					reportPartInstanceHasStarted(playingPartInstance, startedPlayback)

					afterTake(rundown, playingPartInstance)
				}
			} else {
				throw new Meteor.Error(404, `PartInstance "${partInstanceId}" in rundown "${rundownId}" not found!`)
			}
		})
	}
	/**
	 * Triggered from Playout-gateway when a Part has stopped playing
	 */
	export function onPartPlaybackStopped (rundownId: string, partInstanceId: string, stoppedPlayback: Time) { // TODO - rename method
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
					partInstance.startedPlayback &&
					!partInstance.stoppedPlayback
				)
				if (isPlaying) {
					logger.info(`Playout reports PartInstance "${partInstanceId}" has stopped playback on timestamp ${(new Date(stoppedPlayback)).toISOString()}`)

					reportPartInstanceHasStopped(partInstance, stoppedPlayback)
				}
			} else {
				throw new Meteor.Error(404, `Part "${partInstanceId}" in rundown "${rundownId}" not found!`)
			}
		})
	}
	/**
	 * Make a copy of a piece and start playing it now
	 */
	export function pieceTakeNow (rundownId: string, partId: string, pieceId: string) {
		check(rundownId, String)
		check(partId, String)
		check(pieceId, String)

		return ServerPlayoutAdLibAPI.pieceTakeNow(rundownId, partId, pieceId)
	}
	export function segmentAdLibPieceStart (rundownId: string, partId: string, adLibPieceId: string, queue: boolean) {
		check(rundownId, String)
		check(partId, String)
		check(adLibPieceId, String)

		return ServerPlayoutAdLibAPI.segmentAdLibPieceStart(rundownId, partId, adLibPieceId, queue)
	}
	export function rundownBaselineAdLibPieceStart (rundownId: string, partId: string, baselineAdLibPieceId: string, queue: boolean) {
		check(rundownId, String)
		check(partId, String)
		check(baselineAdLibPieceId, String)

		return ServerPlayoutAdLibAPI.rundownBaselineAdLibPieceStart(rundownId, partId, baselineAdLibPieceId, queue)
	}
	export function stopAdLibPiece (rundownId: string, partId: string, pieceId: string) {
		check(rundownId, String)
		check(partId, String)
		check(pieceId, String)

		return ServerPlayoutAdLibAPI.stopAdLibPiece(rundownId, partId, pieceId)
	}
	export function sourceLayerStickyPieceStart (rundownId: string, sourceLayerId: string) {
		check(rundownId, String)
		check(sourceLayerId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Pieces can be only manipulated in an active rundown!`)
			if (!rundown.currentPartInstanceId) throw new Meteor.Error(400, `A part needs to be active to place a sticky item`)

			const showStyleBase = rundown.getShowStyleBase()
			const sourceLayer = showStyleBase.sourceLayers.find(i => i._id === sourceLayerId)
			if (!sourceLayer) throw new Meteor.Error(404, `Source layer "${sourceLayerId}" not found!`)
			if (!sourceLayer.isSticky) throw new Meteor.Error(400, `Only sticky layers can be restarted. "${sourceLayerId}" is not sticky.`)

			const lastPieceInstances = PieceInstances.find({
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

			if (lastPieceInstances.length > 0) {
				const currentPartInstance = PartInstances.findOne(rundown.currentPartInstanceId)
				if (!currentPartInstance) throw new Meteor.Error(501, `Current Part "${rundown.currentPartInstanceId}" could not be found.`)

				const adlibPiece = convertPieceToAdLibPiece(lastPieceInstances[0])
				const newAdLibPiece = convertAdLibToPiece(adlibPiece, currentPartInstance, false)

				Pieces.insert(newAdLibPiece)

				// logger.debug('adLibItemStart', newPiece)

				cropInfinitesOnLayer(rundown, currentPart, newAdLibPiece)
				stopInfinitesRunningOnLayer(rundown, currentPart, newAdLibPiece.sourceLayerId)

				updateTimeline(rundown.studioId)
			}
		})
	}
	export function sourceLayerStopActivePiece (rundownId: string, sourceLayerId: string) {
		check(rundownId, String)
		check(sourceLayerId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Pieces can be only manipulated in an active rundown!`)
			if (!rundown.currentPartInstanceId) throw new Meteor.Error(403, `Pieces can be only manipulated when a part is active!`)

			const currentPartInstance = PartInstances.findOne({
				_id: rundown.currentPartInstanceId,
				rundownId: rundownId
			})
			if (!currentPartInstance) throw new Meteor.Error(404, `PartInstance "${rundown.currentPartInstanceId}" not found!`)
			if (!currentPartInstance.startedPlayback) throw new Meteor.Error(405, `PartInstance "${rundown.currentPartInstanceId}" has yet to start playback!`)

			const now = getCurrentTime()
			const relativeNow = now - currentPartInstance.startedPlayback
			const orderedPieces = getResolvedPieces(part)

			orderedPieces.forEach((piece) => {
				if (piece.sourceLayerId === sourceLayerId) {
					if (!piece.userDuration) {
						let newExpectedDuration: number | undefined = undefined

						if (piece.infiniteId && piece.infiniteId !== piece._id && part) {
							const partStarted = part.getLastStartedPlayback()
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
	export function rundownTogglePartArgument (rundownId: string, partId: string, property: string, value: string) {
		check(rundownId, String)
		check(partId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (rundown.holdState === RundownHoldState.ACTIVE || rundown.holdState === RundownHoldState.PENDING) {
				throw new Meteor.Error(403, `Part Arguments can not be toggled when hold is used!`)
			}

			let part = Parts.findOne(partId)
			if (!part) throw new Meteor.Error(404, `Part "${partId}" not found!`)

			const rArguments = part.runtimeArguments || {}

			if (rArguments[property] === value) {
				// unset property
				const mUnset: any = {}
				mUnset['runtimeArguments.' + property] = 1
				Parts.update(part._id, {$unset: mUnset, $set: {
					dirty: true
				}})
			} else {
				// set property
				const mSet: any = {}
				mSet['runtimeArguments.' + property] = value
				mSet.dirty = true
				Parts.update(part._id, { $set: mSet })
			}

			part = Parts.findOne(partId)

			if (!part) throw new Meteor.Error(404, `Part "${partId}" not found!`)

			refreshPart(rundown, part)

			// Only take time to update the timeline if there's a point to do it
			if (rundown.active) {
				// If this part is rundown's next, check if current part has autoNext
				if ((rundown.nextPartId === part._id) && rundown.currentPartId) {
					const currentPart = Parts.findOne(rundown.currentPartId)
					if (currentPart && currentPart.autoNext) {
						updateTimeline(rundown.studioId)
					}
				// If this is rundown's current part, update immediately
				} else if (rundown.currentPartId === part._id) {
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
					enable: {
						start: time
					}
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

function beforeTake (rundownData: RundownData, currentPart: Part | null, nextPart: Part) {
	if (currentPart) {
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
		const currentPieces = currentPart.getAllPieces()
		currentPieces.forEach((piece) => {
			if (piece.overflows && typeof piece.enable.duration === 'number' && piece.enable.duration > 0 && piece.playoutDuration === undefined && piece.userDuration === undefined) {
				// Subtract the amount played from the duration
				const remainingDuration = Math.max(0, piece.enable.duration - ((piece.startedPlayback || currentPart.getLastStartedPlayback() || getCurrentTime()) - getCurrentTime()))

				if (remainingDuration > 0) {
					// Clone an overflowing piece
					let overflowedItem = literal<Piece>({
						..._.omit(piece, 'startedPlayback', 'duration', 'overflows'),
						_id: Random.id(),
						partId: nextPart._id,
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
	rundown: Rundown,
	takePart: Part,
	timeOffset: number | null = null
) {
	// This function should be called at the end of a "take" event (when the Parts have been updated)

	let forceNowTime: number | undefined = undefined
	if (timeOffset) {
		forceNowTime = getCurrentTime() - timeOffset
	}
	// or after a new part has started playing
	updateTimeline(rundown.studioId, forceNowTime)

	// defer these so that the playout gateway has the chance to learn about the changes
	Meteor.setTimeout(() => {
		if (takePart.updateStoryStatus) {
			IngestActions.notifyCurrentPlayingPart(rundown, takePart)

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
