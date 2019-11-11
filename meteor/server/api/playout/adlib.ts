import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import { Random } from 'meteor/random'
import * as _ from 'underscore'
import { SourceLayerType, PieceLifespan, getPieceGroupId } from 'tv-automation-sofie-blueprints-integration'
import { getCurrentTime, literal } from '../../../lib/lib'
import { logger } from '../../../lib/logging'
import { Rundowns, RundownHoldState, Rundown } from '../../../lib/collections/Rundowns'
import { Timeline } from '../../../lib/collections/Timeline'
import { AdLibPieces, AdLibPiece } from '../../../lib/collections/AdLibPieces'
import { RundownBaselineAdLibPieces } from '../../../lib/collections/RundownBaselineAdLibPieces'
import { Pieces, Piece } from '../../../lib/collections/Pieces'
import { convertAdLibToPieceInstance, getResolvedPieces } from './pieces'
import { cropInfinitesOnLayer, stopInfinitesRunningOnLayer } from './infinites'
import { updateTimeline } from './timeline'
// import { updatePartRanks } from '../rundown'
import { rundownSyncFunction, RundownSyncFunctionPriority } from '../ingest/rundownInput'
import { PartInstances } from '../../../lib/collections/PartInstances'
import { PieceInstances } from '../../../lib/collections/PieceInstances'

import { ServerPlayoutAPI } from './playout' // TODO - this should not be calling back like this

export namespace ServerPlayoutAdLibAPI {
	export function pieceTakeNow (rundownId: string, partInstanceId: string, pieceId: string) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Part AdLib-pieces can be only placed in an active rundown!`)

			// TODO - this needs to handle a PieceInstance or a Piece being selected

			const piece = Pieces.findOne({
				_id: pieceId,
				rundownId: rundownId
			}) as Piece
			if (!piece) throw new Meteor.Error(404, `Piece "${pieceId}" not found!`)

			const partInstance = PartInstances.findOne({
				_id: partInstanceId,
				rundownId: rundownId
			})
			if (!partInstance) throw new Meteor.Error(404, `PartInstance "${partInstanceId}" not found!`)
			if (rundown.currentPartInstanceId !== partInstance._id) throw new Meteor.Error(403, `PartInstance AdLib-pieces can be only placed in a current partInstance!`)

			const showStyleBase = rundown.getShowStyleBase()
			const sourceL = showStyleBase.sourceLayers.find(i => i._id === piece.sourceLayerId)
			if (sourceL && sourceL.type !== SourceLayerType.GRAPHICS) throw new Meteor.Error(403, `Piece "${pieceId}" is not a GRAPHICS item!`)

			const newPieceInstance = convertAdLibToPieceInstance(piece, partInstance, false)

			// Disable the original piece if from the same Part
			if (piece.partId === partInstance.part._id) {
				const pieceInstances = getResolvedPieces(partInstance)
				const resPiece = pieceInstances.find(p => p.piece._id === piece._id) // TODO - this doesnt mean the content is the same..

				if (resPiece && resPiece.timings.startedPlayback && resPiece.timings.startedPlayback <= getCurrentTime()) {
					if (
						resPiece &&
						resPiece.playoutDuration !== undefined &&
						(
							piece.infiniteMode ||
							resPiece.timings.startedPlayback + resPiece.playoutDuration >= getCurrentTime()
						)
					) {
						// logger.debug(`Piece "${piece._id}" is currently live and cannot be used as an ad-lib`)
						throw new Meteor.Error(409, `Piece "${piece._id}" is currently live and cannot be used as an ad-lib`)
					}
				}

				Pieces.update(piece._id, {$set: {
					disabled: true,
					hidden: true
				}})
			}
			PieceInstances.insert(newPieceInstance)

			cropInfinitesOnLayer(rundown, partInstance, newPieceInstance)
			stopInfinitesRunningOnLayer(rundown, partInstance, newPieceInstance.piece.sourceLayerId)
			updateTimeline(rundown.studioId)
		})
	}
	export function segmentAdLibPieceStart (rundownId: string, partInstanceId: string, adLibPieceId: string, queue: boolean) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Part AdLib-pieces can be only placed in an active rundown!`)
			if (rundown.holdState === RundownHoldState.ACTIVE || rundown.holdState === RundownHoldState.PENDING) {
				throw new Meteor.Error(403, `Part AdLib-pieces can not be used in combination with hold!`)
			}
			const adLibPiece = AdLibPieces.findOne({
				_id: adLibPieceId,
				rundownId: rundownId
			})
			if (!adLibPiece) throw new Meteor.Error(404, `Part Ad Lib Item "${adLibPieceId}" not found!`)
			if (adLibPiece.invalid) throw new Meteor.Error(404, `Cannot take invalid Part Ad Lib Item "${adLibPieceId}"!`)

			if (!queue && rundown.currentPartInstanceId !== partInstanceId) throw new Meteor.Error(403, `PartInstance AdLib-pieces can be only placed in a currently playing partInstance!`)

			innerStartAdLibPiece(rundown, queue, partInstanceId, adLibPiece)
		})
	}
	export function rundownBaselineAdLibPieceStart (rundownId: string, partInstanceId: string, baselineAdLibPieceId: string, queue: boolean) {
		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			logger.debug('rundownBaselineAdLibPieceStart')

			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Rundown Baseline AdLib-pieces can be only placed in an active rundown!`)
			if (rundown.holdState === RundownHoldState.ACTIVE || rundown.holdState === RundownHoldState.PENDING) {
				throw new Meteor.Error(403, `Part AdLib-pieces can not be used in combination with hold!`)
			}

			const adLibPiece = RundownBaselineAdLibPieces.findOne({
				_id: baselineAdLibPieceId,
				rundownId: rundownId
			})
			if (!adLibPiece) throw new Meteor.Error(404, `Rundown Baseline Ad Lib Item "${baselineAdLibPieceId}" not found!`)
			if (!queue && rundown.currentPartInstanceId !== partInstanceId) throw new Meteor.Error(403, `Rundown Baseline AdLib-pieces can be only placed in a currently playing partInstance!`)

			innerStartAdLibPiece(rundown, queue, partInstanceId, adLibPiece)
		})
	}
	function innerStartAdLibPiece (rundown: Rundown, queue: boolean, partInstanceId: string, adLibPiece: AdLibPiece) {
		let orgPartInstanceId = partInstanceId
		if (queue) {
			// insert a NEW, adlibbed part after this part
			partInstanceId = adlibQueueInsertPartInstance(rundown, partInstanceId, adLibPiece)
		}
		let partInstance = PartInstances.findOne({
			_id: partInstanceId,
			rundownId: rundown._id
		})
		if (!partInstance) throw new Meteor.Error(404, `PartInstance "${partInstanceId}" not found!`)

		const newPieceInstance = convertAdLibToPieceInstance(adLibPiece, partInstance, queue)
		PieceInstances.insert(newPieceInstance)

		if (queue) {
			// keep infinite pieces
			// TODO - should this not handled by a call to updateInfinites?
			// Pieces.find({ rundownId: rundown._id, partId: orgPartId }).forEach(piece => {
			// 	// console.log(piece.name + ' has life span of ' + piece.infiniteMode)
			// 	if (piece.infiniteMode && piece.infiniteMode >= PieceLifespan.Infinite) {
			// 		let newPiece = convertAdLibToPieceInstance(piece, part!, queue)
			// 		Pieces.insert(newPiece)
			// 	}
			// })

			ServerPlayoutAPI.setNextPartInner(rundown, partInstance)
		} else {
			cropInfinitesOnLayer(rundown, partInstance, newPieceInstance)
			stopInfinitesRunningOnLayer(rundown, partInstance, newPieceInstance.piece.sourceLayerId)
			updateTimeline(rundown.studioId)
		}
	}
	function adlibQueueInsertPartInstance (rundown: Rundown, afterPartInstanceId: string, adLibPiece: AdLibPiece) {
		logger.info('adlibQueueInsertPartInstance')

		const afterPartInstance = PartInstances.findOne(afterPartInstanceId)
		if (!afterPartInstance) throw new Meteor.Error(404, `PartInstance "${afterPartInstanceId}" not found!`)

		const newPartInstanceId = Random.id()
		PartInstances.insert({
			_id: newPartInstanceId,
			segmentId: afterPartInstance.segmentId,
			rundownId: rundown._id,
			takeCount: afterPartInstance.takeCount + 1,
			part: {
				_id: `${newPartInstanceId}_part`,
				_rank: 99999, // something high, so it will be placed last
				externalId: '',
				segmentId: afterPartInstance.segmentId,
				rundownId: rundown._id,
				title: adLibPiece.name,
				typeVariant: 'adlib'
			},
			timings: {}
		})

		// updatePartRanks(rundown._id) // place in order

		return newPartInstanceId
	}
	export function stopAdLibPiece (rundownId: string, partInstanceId: string, pieceId: string) {
		check(rundownId, String)
		check(partInstanceId, String)
		check(pieceId, String)

		return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Playout, () => {
			const rundown = Rundowns.findOne(rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${rundownId}" not found!`)
			if (!rundown.active) throw new Meteor.Error(403, `Part AdLib-copy-pieces can be only manipulated in an active rundown!`)
			if (rundown.currentPartInstanceId !== partInstanceId) throw new Meteor.Error(403, `Part AdLib-copy-pieces can be only manipulated in a current partInstance!`)

			const partInstance = PartInstances.findOne({
				_id: partInstanceId,
				rundownId: rundownId
			})
			if (!partInstance) throw new Meteor.Error(404, `PartInstance "${partInstanceId}" not found!`)

			const pieceInstance = PieceInstances.findOne({
				'piece._id': pieceId,
				rundownId: rundownId,
				partInstanceId: partInstanceId
			})
			if (!pieceInstance) throw new Meteor.Error(404, `Part AdLib-copy-piece "${pieceId}" not found!`)
			if (!pieceInstance.dynamicallyInserted) throw new Meteor.Error(501, `"${pieceId}" does not appear to be a dynamic Piece!`)
			if (!pieceInstance.adLibSourceId) throw new Meteor.Error(501, `"${pieceId}" does not appear to be a Part AdLib-copy-piece!`)

			// To establish playback time, we need to look at the actual Timeline
			const tlObj = Timeline.findOne({
				_id: getPieceGroupId(pieceId)
			})
			if (!tlObj) throw new Meteor.Error(404, `Part AdLib-copy-piece "${pieceId}" not found in the playout Timeline!`)

			// The ad-lib item positioning will be relative to the startedPlayback of the part
			const parentOffset = partInstance.timings.startedPlayback || 0

			let newExpectedDuration = 0
			if (pieceInstance.timings.startedPlayback) {
				newExpectedDuration = getCurrentTime() - pieceInstance.timings.startedPlayback
			} else if (_.isNumber(tlObj.enable.start)) {
				// If start is absolute within the part, we can do a better estimate
				const actualStartTime = parentOffset + tlObj.enable.start
				newExpectedDuration = getCurrentTime() - actualStartTime
			} else {
				logger.warn(`"${pieceId}" timeline object is not positioned absolutely or is still set to play now, assuming it's about to be played.`)
			}

			PieceInstances.update({
				_id: pieceInstance._id
			}, {
				$set: {
					// TODO - this field doesnt currently exist..
					userDuration: newExpectedDuration
				}
			})

			updateTimeline(rundown.studioId)
		})
	}
}
