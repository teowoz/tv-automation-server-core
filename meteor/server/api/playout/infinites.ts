import * as _ from 'underscore'
import { Meteor } from 'meteor/meteor'
import { PieceLifespan, getPieceGroupId } from 'tv-automation-sofie-blueprints-integration'

import { Rundown } from '../../../lib/collections/Rundowns'
import { Part } from '../../../lib/collections/Parts'
import { syncFunctionIgnore, syncFunction } from '../../codeControl'
import { Piece, Pieces } from '../../../lib/collections/Pieces'
import { getOrderedPiece, PieceResolved } from './pieces'
import { asyncCollectionUpdate, waitForPromiseAll, asyncCollectionRemove, asyncCollectionInsert, normalizeArray, toc, makePromise, waitForPromise } from '../../../lib/lib'
import { PartInstance, WrapPartToTemporaryInstance, FindPartInstanceOrWrapToTemporary } from '../../../lib/collections/PartInstances'
import { PieceInstances, PieceInstance, WrapPieceToTemporaryInstance } from '../../../lib/collections/PieceInstances'

/**
 * To allow infinites to work through the PartInstances refactor only phase, we need them to be a bit hybrid so as to let PartInstances override timings,
 * and propogate back to the original Parts (I know that is horrible). This is temporary until the new infinites logic is implemented.
 * As part of this, it means that all PartInstances need their original Part to exist while they do, which is going to be enforced at ingest during this transitionary phase.
 */

export const updateSourceLayerInfinitesAfterPart: (rundown: Rundown, previousPart?: Part, runUntilEnd?: boolean) => void
= syncFunctionIgnore(updateSourceLayerInfinitesAfterPartInner)
export function updateSourceLayerInfinitesAfterPartInner (rundown: Rundown, previousPart2?: Part, runUntilEnd?: boolean): string {
	let activeInfinitePieces: { [layer: string]: Piece } = {}
	let activeInfiniteItemsSegmentId: { [layer: string]: string } = {}

	if (previousPart2 === undefined) {
	   // If running from start (no previousPart), then always run to the end
	   runUntilEnd = true
	}

	let ps: Array<Promise<any>> = []

	const partInstances = rundown.getActivePartInstances()
	const pPartsToProcess = makePromise(() => rundown.getParts())

	const previousPartInstance = previousPart2 ? (partInstances.find(p => p.part._id === previousPart2._id) || WrapPartToTemporaryInstance(previousPart2)) : undefined

	const getPartInstancePieces = (partInstance: PartInstance) => {
		return partInstance.isTemporary ? _.map(partInstance.part.getAllPieces(), p => WrapPieceToTemporaryInstance(p, partInstance._id)) : partInstance.getAllPieceInstances()
	}

	if (previousPartInstance) {
	   // figure out the baseline to set
	   const prevPieces = getOrderedPiece(previousPartInstance, getPartInstancePieces(previousPartInstance))
	   _.each(prevPieces, piece => {
		   if (!piece.piece.infiniteMode || piece.playoutDuration || piece.userDuration || piece.piece.enable.end || piece.piece.enable.duration) {
			   delete activeInfinitePieces[piece.piece.sourceLayerId]
			   delete activeInfiniteItemsSegmentId[piece.piece.sourceLayerId]
		   } else {
			   if (!piece.piece.infiniteId) {
				   // ensure infinite id is set
				   piece.piece.infiniteId = piece.piece._id
				   ps.push(
					   asyncCollectionUpdate(Pieces, piece.piece._id, {
						   $set: { infiniteId: piece.piece.infiniteId }
					   })
				   )
				   ps.push(
					asyncCollectionUpdate(PieceInstances, piece._id, {
						$set: { 'piece.infiniteId': piece.piece.infiniteId }
					})
				)
				//    logger.debug(`updateSourceLayerInfinitesAfterPart: marked "${piece._id}" as start of infinite`)
			   }
			   if (piece.piece.infiniteMode !== PieceLifespan.OutOnNextPart) {
				   activeInfinitePieces[piece.piece.sourceLayerId] = piece.piece
				   activeInfiniteItemsSegmentId[piece.piece.sourceLayerId] = previousPartInstance.segmentId
			   }
		   }
	   })
	}

	let rawPartsToProcess = waitForPromise(pPartsToProcess)
	waitForPromiseAll(ps)

	if (previousPartInstance) {
		// TODO - is this the correct rank?
		rawPartsToProcess = rawPartsToProcess.filter(l => l._rank > previousPartInstance.part._rank)
	}
	const partsToProcess = _.map(rawPartsToProcess, part => FindPartInstanceOrWrapToTemporary(partInstances, part))

   // Prepare pieces:
	let psPopulateCache: Array<Promise<any>> = []
	const currentItemsCache: {[partId: string]: PieceResolved[]} = {}
	_.each(partsToProcess, (part) => {
	   psPopulateCache.push(new Promise((resolve, reject) => {
		   try {
			   let currentItems = getOrderedPiece(part, getPartInstancePieces(part))

			   currentItemsCache[part._id] = currentItems
			   resolve()
		   } catch (e) {
			   reject(e)
		   }
	   }))
	})
	waitForPromiseAll(psPopulateCache)

	ps = []
	for (let part of partsToProcess) {
	   // Drop any that relate only to previous segments
	   for (let k in activeInfiniteItemsSegmentId) {
		   let s = activeInfiniteItemsSegmentId[k]
		   let i = activeInfinitePieces[k]
		   if (!i.infiniteMode || i.infiniteMode === PieceLifespan.OutOnNextSegment && s !== part.segmentId) {
			   delete activeInfinitePieces[k]
			   delete activeInfiniteItemsSegmentId[k]
		   }
	   }

	   // ensure any currently defined infinites are still wanted
	   // let currentItems = getOrderedPiece(part)
	   let currentItems = currentItemsCache[part._id]
	   if (!currentItems) throw new Meteor.Error(500, `currentItemsCache didn't contain "${part._id}", which it should have`)

	   let currentInfinites = currentItems.filter(i => i.infiniteId && i.infiniteId !== i._id)
	   let removedInfinites: string[] = []

	   for (let piece of currentInfinites) {
		   const active = activeInfinitePieces[piece.sourceLayerId]
		   if (!active || active.infiniteId !== piece.infiniteId) {
			   // Previous piece no longer enforces the existence of this one
			   ps.push(asyncCollectionRemove(Pieces, piece._id))

			   removedInfinites.push(piece._id)
			//    logger.debug(`updateSourceLayerInfinitesAfterPart: removed old infinite "${piece._id}" from "${piece.partId}"`)
		   }
	   }

	   // stop if not running to the end and there is/was nothing active
	   const midInfinites = currentInfinites.filter(i => !i.enable.end && !i.enable.duration && i.infiniteMode)
	   if (!runUntilEnd && Object.keys(activeInfiniteItemsSegmentId).length === 0 && midInfinites.length === 0) {
		   // TODO - this guard is useless, as all shows have klokke and logo as infinites throughout...
		   // This should instead do a check after each iteration to check if anything changed (even fields such as name on the piece)
		   // If nothing changed, then it is safe to assume that it doesnt need to go further
		   return part._id
	   }

	   // figure out what infinites are to be extended
	   currentItems = currentItems.filter(i => removedInfinites.indexOf(i._id) < 0)
	   let oldInfiniteContinuation: string[] = []
	   let newInfiniteContinations: Piece[] = []
	   for (let k in activeInfinitePieces) {
		   let newPiece: Piece = activeInfinitePieces[k]

		   let existingPiece: PieceResolved | undefined = undefined
		   let allowInsert: boolean = true

		   // If something exists on the layer, the infinite must be stopped and potentially replaced
		   const existingItems = currentItems.filter(i => i.sourceLayerId === newPiece.sourceLayerId)
		   if (existingItems && existingItems.length > 0) {
			   // remove the existing, as we need to update its contents
			   const existInf = existingItems.findIndex(e => !!e.infiniteId && e.infiniteId === newPiece.infiniteId)
			   if (existInf >= 0) {
				   existingPiece = existingItems[existInf]
				   oldInfiniteContinuation.push(existingPiece._id)

				   existingItems.splice(existInf, 1)
			   }

			   if (existingItems.length > 0) {
				   // It will be stopped by this line
				   delete activeInfinitePieces[k]
				   delete activeInfiniteItemsSegmentId[k]

				   const lastExistingPiece = _.last(existingItems) as PieceResolved
				   const firstExistingPiece = _.first(existingItems) as PieceResolved
				   // if we matched with an infinite, then make sure that infinite is kept going
				   if (lastExistingPiece.infiniteMode && lastExistingPiece.infiniteMode !== PieceLifespan.OutOnNextPart) {
					   activeInfinitePieces[k] = existingItems[0]
					   activeInfiniteItemsSegmentId[k] = part.segmentId
				   }

				   // If something starts at the beginning, then dont bother adding this infinite.
				   // Otherwise we should add the infinite but set it to end at the start of the first piece
				   if (firstExistingPiece.enable.start === 0) {
					   // skip the infinite, as it will never show
					   allowInsert = false
				   }
			   }
		   }
		   newPiece.partId = part._id
		   newPiece.continuesRefId = newPiece._id
		   newPiece.enable = { start: 0 }
		   newPiece._id = newPiece.infiniteId + '_' + part._id
		   newPiece.startedPlayback = undefined
		   newPiece.stoppedPlayback = undefined
		   newPiece.timings = undefined

		   if (existingItems && existingItems.length) {
			   newPiece.enable.end = `#${getPieceGroupId(existingItems[0])}.start`
			   delete newPiece.enable.duration
			   newPiece.infiniteMode = PieceLifespan.Normal // it is no longer infinite, and the ui needs this to draw properly
		   }

		   if (existingPiece) { // Some properties need to be persisted
			   newPiece.userDuration = existingPiece.userDuration
			   newPiece.startedPlayback = existingPiece.startedPlayback
			   newPiece.stoppedPlayback = existingPiece.stoppedPlayback
			   newPiece.timings = existingPiece.timings
		   }

		   let pieceToInsert: Piece | null = (allowInsert ? newPiece : null)
		   if (pieceToInsert) {
			   newInfiniteContinations.push(pieceToInsert)

			   delete pieceToInsert['resolvedStart']
			   delete pieceToInsert['resolved']
		   }

		   if (existingPiece && pieceToInsert && _.isEqual(existingPiece, pieceToInsert)) {
			   // no change, since the new piece is equal to the existing one
			   // logger.debug(`updateSourceLayerInfinitesAfterPart: no change to infinite continuation "${itemToInsert._id}"`)
		   } else if (existingPiece && pieceToInsert && existingPiece._id === pieceToInsert._id) {
			   // same _id; we can do an update:
			   ps.push(asyncCollectionUpdate(Pieces, pieceToInsert._id, pieceToInsert))// note; not a $set, because we want to replace the object
			//    logger.debug(`updateSourceLayerInfinitesAfterPart: updated infinite continuation "${pieceToInsert._id}"`)
		   } else {
			   if (existingPiece) {
				   ps.push(asyncCollectionRemove(Pieces, existingPiece._id))
			   }
			   if (pieceToInsert) {
				   ps.push(asyncCollectionInsert(Pieces, pieceToInsert))
				//    logger.debug(`updateSourceLayerInfinitesAfterPart: inserted infinite continuation "${pieceToInsert._id}"`)
			   }
		   }
	   }

	   // find any new infinites exposed by this
	   currentItems = currentItems.filter(i => oldInfiniteContinuation.indexOf(i._id) < 0)
	   for (let piece of newInfiniteContinations.concat(currentItems)) {
		   if (
			   !piece.infiniteMode ||
			   piece.playoutDuration ||
			   piece.userDuration ||
			   piece.enable.end ||
			   piece.enable.duration
		   ) {
			   delete activeInfinitePieces[piece.sourceLayerId]
			   delete activeInfiniteItemsSegmentId[piece.sourceLayerId]
		   } else if (piece.infiniteMode !== PieceLifespan.OutOnNextPart) {
			   if (!piece.infiniteId) {
				   // ensure infinite id is set
				   piece.infiniteId = piece._id
				   ps.push(asyncCollectionUpdate(Pieces, piece._id, { $set: {
					   infiniteId: piece.infiniteId }
				   }))
				//    logger.debug(`updateSourceLayerInfinitesAfterPart: marked "${piece._id}" as start of infinite`)
			   }

			   activeInfinitePieces[piece.sourceLayerId] = piece
			   activeInfiniteItemsSegmentId[piece.sourceLayerId] = part.segmentId
		   }
	   }
	}

	waitForPromiseAll(ps)
	return ''
}

export const cropInfinitesOnLayer = syncFunction(function cropInfinitesOnLayer (rundown: Rundown, partInstance: PartInstance, newPieceInstance: PieceInstance) {
	const showStyleBase = rundown.getShowStyleBase()
	const exclusiveGroup = _.find(showStyleBase.sourceLayers, sl => sl._id === newPieceInstance.piece.sourceLayerId)
	const newItemExclusivityGroup = exclusiveGroup ? exclusiveGroup.exclusiveGroup : undefined
	const layersInExclusivityGroup = newItemExclusivityGroup ? _.map(_.filter(showStyleBase.sourceLayers, sl => sl.exclusiveGroup === newItemExclusivityGroup), i => i._id) : [newPieceInstance.piece.sourceLayerId]

	const pieceInstances = partInstance.getAllPieceInstances().filter(i =>
		i._id !== newPieceInstance._id && i.piece.infiniteMode &&
		(i.piece.sourceLayerId === newPieceInstance.piece.sourceLayerId || layersInExclusivityGroup.indexOf(i.piece.sourceLayerId) !== -1)
	)

	let ps: Array<Promise<any>> = []
	for (const piece of pieceInstances) {
		ps.push(asyncCollectionUpdate(PieceInstances, piece._id, { $set: {
			// TODO - this looks pretty broken...
			userDuration: { end: `#${getPieceGroupId(newPieceInstance.piece)}.start + ${newPieceInstance.piece.adlibPreroll || 0}` },
			'piece.infiniteMode': PieceLifespan.Normal,
			// originalInfiniteMode: piece.originalInfiniteMode !== undefined ? piece.originalInfiniteMode : piece.infiniteMode
		}}))
	}
	waitForPromiseAll(ps)
})

export const stopInfinitesRunningOnLayer = syncFunction(function stopInfinitesRunningOnLayer (rundown: Rundown, partInstance: PartInstance, sourceLayer: string) {
	const rundownParts = rundown.getParts()
	const currentRundownPart = rundownParts.find(p => p._id === partInstance.part._id)
	if (!currentRundownPart) {
		throw new Meteor.Error(404, `Rundown ${rundown._id} does not have the Part ${partInstance.part._id} for active PartInstance ${partInstance._id}`)
	}

	const remainingParts = rundownParts.filter(l => l._rank > currentRundownPart._rank)
	// Update future parts
	for (let line of remainingParts) {
		const continuations = line.getAllPieces().filter(i => i.infiniteMode && i.infiniteId && i.infiniteId !== i._id && i.sourceLayerId === sourceLayer)
		if (continuations.length === 0) {
			// We can stop searching once a part doesnt include it
			break
		}

		continuations.forEach(i => Pieces.remove(i._id))
	}

	// Also update the nextPartInstance
	const { nextPartInstance } = rundown.getSelectedPartInstances()
	if (nextPartInstance) {
		nextPartInstance.getAllPieceInstances()
			.filter(p => p.piece.infiniteMode && p.piece.infiniteId && p.piece.infiniteId !== p.piece._id && p.piece.sourceLayerId === sourceLayer)
			.forEach(p => PieceInstances.remove(p._id))
	}

	// ensure adlib is extended correctly if infinite
	updateSourceLayerInfinitesAfterPart(rundown, partInstance)
})
