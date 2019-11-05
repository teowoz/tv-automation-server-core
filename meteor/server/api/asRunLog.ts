import { Meteor } from 'meteor/meteor'
import * as _ from 'underscore'
import {
	AsRunLogEventBase,
	AsRunLog,
	AsRunLogEvent
} from '../../lib/collections/AsRunLog'
import {
	getCurrentTime,
	Time,
	waitForPromise,
	pushOntoPath,
	waitForPromiseAll,
	asyncCollectionFindOne,
	asyncCollectionUpdate,
	extendMandadory,
	asyncCollectionUpsert,
	getHash,
	literal
} from '../../lib/lib'
import {
	Rundown,
	Rundowns
} from '../../lib/collections/Rundowns'
import { Part, Parts } from '../../lib/collections/Parts'
import { Piece, Pieces } from '../../lib/collections/Pieces'
import { logger } from '../../lib/logging'
import { IBlueprintExternalMessageQueueObj, IBlueprintAsRunLogEventContent } from 'tv-automation-sofie-blueprints-integration'
import { queueExternalMessages } from './ExternalMessageQueue'
import { getBlueprintOfRundown } from './blueprints/cache'
import { AsRunEventContext } from './blueprints/context'
import { PartInstance, PartInstances } from '../../lib/collections/PartInstances'
import { PieceInstance, PieceInstances } from '../../lib/collections/PieceInstances'

const EVENT_WAIT_TIME = 500

export async function pushAsRunLogAsync (eventBase: AsRunLogEventBase, rehersal: boolean, timestamp?: Time): Promise<AsRunLogEvent | null> {
	if (!timestamp) timestamp = getCurrentTime()

	let event: AsRunLogEvent = extendMandadory<AsRunLogEventBase, AsRunLogEvent>(eventBase, {
		_id: getHash(JSON.stringify(eventBase) + timestamp + '_' + rehersal),
		timestamp: timestamp,
		rehersal: rehersal
	})

	let result = await asyncCollectionUpsert(AsRunLog, event._id, event)
	if (result.insertedId) {
		return event
	} else {
		return null
	}
}
export function pushAsRunLog (eventBase: AsRunLogEventBase, rehersal: boolean, timestamp?: Time): AsRunLogEvent | null {
	let p = pushAsRunLogAsync(eventBase, rehersal, timestamp)

	return waitForPromise(p)
}

/**
 * Called after an asRun log event occurs
 * @param event
 */
function handleEvent (event: AsRunLogEvent): void {
	// wait EVENT_WAIT_TIME, because blueprint.onAsRunEvent() might depend on events that
	// might havent been reported yet
	Meteor.setTimeout(() => {
		try {
			if (event.rundownId) {

				const rundown = Rundowns.findOne(event.rundownId) as Rundown
				if (!rundown) throw new Meteor.Error(404, `Rundown "${event.rundownId}" not found!`)

				const { blueprint } = getBlueprintOfRundown(rundown)

				if (blueprint.onAsRunEvent) {
					const context = new AsRunEventContext(rundown, undefined, event)

					Promise.resolve(blueprint.onAsRunEvent(context))
					.then((messages: Array<IBlueprintExternalMessageQueueObj>) => {

						queueExternalMessages(rundown, messages)
					})
					.catch(error => logger.error(error))
				}

			}
		} catch (e) {
			logger.error(e)
		}
	}, EVENT_WAIT_TIME)
}

// Convenience functions:

export function reportRundownHasStarted (rundownOrId: Rundown | string, timestamp?: Time) {
	// Called when the first part in rundown starts playing

	let rundown = (
		_.isString(rundownOrId) ?
		Rundowns.findOne(rundownOrId) :
		rundownOrId
	)
	if (rundown) {
		Rundowns.update(rundown._id, {
			$set: {
				startedPlayback: timestamp
			}
		})
		// also update local object:
		rundown.startedPlayback = timestamp

		let event = pushAsRunLog({
			studioId: rundown.studioId,
			rundownId: rundown._id,
			content: IBlueprintAsRunLogEventContent.STARTEDPLAYBACK,
			content2: 'rundown'
		}, !!rundown.rehearsal, timestamp)
		if (event) handleEvent(event)
	} else logger.error(`rundown not found in reportRundownHasStarted "${rundownOrId}"`)
}
// export function reportSegmentHasStarted (segment: Segment, timestamp?: Time) {
// }
export function reportPartHasStarted (partOrId: PartInstance | string , timestamp: Time) {

	const partInstance = (
		_.isString(partOrId) ?
		PartInstances.findOne(partOrId) :
		partOrId
	)
	if (partInstance) {
		let rundown: Rundown

		let r = waitForPromiseAll<any>([
			asyncCollectionUpdate(PartInstances, partInstance._id, {
				$set: {
					'timings.startedPlayback': timestamp
				}
			}),
			asyncCollectionFindOne(Rundowns, partInstance.rundownId)
		])
		rundown = r[1]
		// also update local object:
		partInstance.timings.startedPlayback = timestamp

		if (rundown) {
			let event = pushAsRunLog({
				studioId:			rundown.studioId,
				rundownId:		rundown._id,
				segmentId:			partInstance.segmentId,
				partId:		partInstance.part._id, // TODO
				content:			IBlueprintAsRunLogEventContent.STARTEDPLAYBACK,
				content2: 			'part'
			}, !!rundown.rehearsal, timestamp)
			if (event) handleEvent(event)
		} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPartHasStarted "${partInstance._id}"`)
	} else logger.error(`part not found in reportPartHasStarted "${partOrId}"`)
}
export function reportPartHasStopped (partOrId: PartInstance | string , timestamp: Time) {

	let partInstance = (
		_.isString(partOrId) ?
		PartInstances.findOne(partOrId) :
		partOrId
	)
	if (partInstance) {
		let rundown: Rundown

		let r = waitForPromiseAll<any>([
			asyncCollectionUpdate(Parts, partInstance._id, {
				$set: {
					'timings.stoppedPlayback': timestamp
				}
			}),
			asyncCollectionFindOne(Rundowns, partInstance.rundownId)
		])
		rundown = r[1]
		// also update local object:
		partInstance.timings.stoppedPlayback = timestamp

		if (rundown) {
			let event = pushAsRunLog({
				studioId:			rundown.studioId,
				rundownId:		rundown._id,
				segmentId:			partInstance.segmentId,
				partId:		partInstance.part._id, // TODO
				content:			IBlueprintAsRunLogEventContent.STOPPEDPLAYBACK,
				content2: 			'part'
			}, !!rundown.rehearsal, timestamp)
			if (event) handleEvent(event)
			return event
		} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPartHasStopped "${partInstance._id}"`)
	} else logger.error(`part not found in reportPartHasStopped "${partOrId}"`)
}

export function reportPieceHasStarted (pieceOrId: PieceInstance | string, timestamp: Time) {

	let pieceInstance = (
		_.isString(pieceOrId) ?
		PieceInstances.findOne(pieceOrId) :
		pieceOrId
	)
	if (pieceInstance) {
		let rundown: Rundown
		let partInstance: Part
		let r = waitForPromiseAll<any>([
			asyncCollectionUpdate(PieceInstances, pieceInstance._id, {
				$set: {
					'timings.startedPlayback': timestamp
				}
			}),
			asyncCollectionFindOne(Rundowns, pieceInstance.rundownId),
			asyncCollectionFindOne(PartInstances, pieceInstance.partInstanceId)
		])
		rundown = r[1]
		partInstance = r[2]
		// also update local object:
		pieceInstance.timings.startedPlayback = timestamp

		if (rundown) {
			let event = pushAsRunLog({
				studioId:			rundown.studioId,
				rundownId:		rundown._id,
				segmentId:			partInstance.segmentId,
				partId:		partInstance._id, // TODO
				pieceId:	pieceInstance.piece._id,
				content:			IBlueprintAsRunLogEventContent.STARTEDPLAYBACK,
				content2: 			'piece'
			}, !!rundown.rehearsal, timestamp)
			if (event) handleEvent(event)
		} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPieceHasStarted "${partInstance._id}"`)

	} else logger.error(`piece not found in reportPieceHasStarted "${pieceOrId}"`)
}
export function reportPieceHasStopped (pieceOrId: PieceInstance | string, timestamp: Time) {

	let pieceInstance = (
		_.isString(pieceOrId) ?
		PieceInstances.findOne(pieceOrId) :
		pieceOrId
	)
	if (pieceInstance) {

		let rundown: Rundown
		let partInstance: Part
		let r = waitForPromiseAll<any>([
			asyncCollectionUpdate(PieceInstances, pieceInstance._id, {
				$set: {
					'timings.stoppedPlayback': timestamp
				}
			}),
			asyncCollectionFindOne(Rundowns, pieceInstance.rundownId),
			asyncCollectionFindOne(PartInstances, pieceInstance.partInstanceId)
		])
		rundown = r[1]
		partInstance = r[2]
		// also update local object:
		pieceInstance.timings.stoppedPlayback = timestamp

		if (rundown) {
			let event = pushAsRunLog({
				studioId:			rundown.studioId,
				rundownId:		rundown._id,
				segmentId:			partInstance.segmentId,
				partId:		partInstance._id, // TODO
				pieceId:	pieceInstance.piece._id,
				content:			IBlueprintAsRunLogEventContent.STOPPEDPLAYBACK,
				content2: 			'piece'
			}, !!rundown.rehearsal, timestamp)
			if (event) handleEvent(event)
		} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPieceHasStopped "${partInstance._id}"`)

	} else logger.error(`piece not found in reportPieceHasStopped "${pieceOrId}"`)
}
