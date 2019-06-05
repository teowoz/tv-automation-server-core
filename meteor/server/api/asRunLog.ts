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
	waitForPromiseAll,
	asyncCollectionFindOne,
	asyncCollectionUpdate,
	extendMandadory,
	asyncCollectionUpsert,
	getHash
} from '../../lib/lib'
import { Rundown, Rundowns } from '../../lib/collections/Rundowns'
import { logger } from '../../lib/logging'
import { IBlueprintExternalMessageQueueObj, IBlueprintAsRunLogEventContent } from 'tv-automation-sofie-blueprints-integration'
import { queueExternalMessages } from './ExternalMessageQueue'
import { getBlueprintOfRundown } from './blueprints/cache'
import { AsRunEventContext } from './blueprints/context'
import { PartInstances, PartInstance } from '../../lib/collections/PartInstances'
import { PieceInstances, PieceInstance } from '../../lib/collections/PieceInstances'

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
export function reportPartInstanceHasStarted (partInstance: PartInstance, timestamp: Time) {
	let rundown: Rundown

	let r = waitForPromiseAll<any>([
		asyncCollectionUpdate(PartInstances, partInstance._id, {
			$set: {
				startedPlayback: timestamp,
			}
		}),
		asyncCollectionFindOne(Rundowns, partInstance.rundownId)
	])
	rundown = r[1]
	// also update local object:
	partInstance.startedPlayback = timestamp

	if (rundown) {
		let event = pushAsRunLog({
			studioId:			rundown.studioId,
			rundownId:		rundown._id,
			segmentId:			partInstance.segmentId,
			partId:		partInstance.partId,
			content:			IBlueprintAsRunLogEventContent.STARTEDPLAYBACK,
			content2: 			'part'
		}, !!rundown.rehearsal, timestamp)
		if (event) handleEvent(event)
	} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPartInstanceHasStarted "${partInstance._id}"`)
}
export function reportPartInstanceHasStopped (partInstance: PartInstance, timestamp: Time) {
	let rundown: Rundown

	let r = waitForPromiseAll<any>([
		asyncCollectionUpdate(PartInstances, partInstance._id, {
			$set: {
				stoppedPlayback: timestamp,
			}
		}),
		asyncCollectionFindOne(Rundowns, partInstance.rundownId)
	])
	rundown = r[1]
	// also update local object:
	partInstance.stoppedPlayback = timestamp

	if (rundown) {
		let event = pushAsRunLog({
			studioId:			rundown.studioId,
			rundownId:		rundown._id,
			segmentId:			partInstance.segmentId,
			partId:		partInstance.partId,
			content:			IBlueprintAsRunLogEventContent.STOPPEDPLAYBACK,
			content2: 			'part'
		}, !!rundown.rehearsal, timestamp)
		if (event) handleEvent(event)
		return event
	} else logger.error(`rundown "${partInstance.rundownId}" not found in reportPartInstanceHasStopped "${partInstance._id}"`)
}

export function reportPieceInstanceHasStarted (pieceInstance: PieceInstance, timestamp: Time) {
	let rundown: Rundown
	let partInstance: PartInstance
	let r = waitForPromiseAll<any>([
		asyncCollectionUpdate(PieceInstances, pieceInstance._id, {
			$set: {
				startedPlayback: timestamp,
				stoppedPlayback: 0
			}
		}),
		asyncCollectionFindOne(Rundowns, pieceInstance.rundownId),
		asyncCollectionFindOne(PartInstances, pieceInstance.partInstanceId)
	])
	rundown = r[1]
	partInstance = r[2]
	// also update local object:
	pieceInstance.startedPlayback = timestamp
	pieceInstance.stoppedPlayback = 0

	if (rundown && partInstance) {
		let event = pushAsRunLog({
			studioId:			rundown.studioId,
			rundownId:		rundown._id,
			segmentId:			partInstance.segmentId,
			partId:		pieceInstance.partId,
			pieceId:	pieceInstance.pieceId,
			content:			IBlueprintAsRunLogEventContent.STARTEDPLAYBACK,
			content2: 			'piece'
		}, !!rundown.rehearsal, timestamp)
		if (event) handleEvent(event)
	} else logger.error(`rundown "${pieceInstance.rundownId}" not found in reportPieceInstanceHasStarted "${pieceInstance._id}"`)
}
export function reportPieceInstanceHasStopped (pieceInstance: PieceInstance, timestamp: Time) {
	let rundown: Rundown
	let partInstance: PartInstance
	let r = waitForPromiseAll<any>([
		asyncCollectionUpdate(PieceInstances, pieceInstance._id, {
			$set: {
				stoppedPlayback: timestamp
			}
		}),
		asyncCollectionFindOne(Rundowns, pieceInstance.rundownId),
		asyncCollectionFindOne(PartInstances, pieceInstance.partInstanceId)
	])
	rundown = r[1]
	partInstance = r[2]
	// also update local object:
	pieceInstance.stoppedPlayback = timestamp

	if (rundown && partInstance) {
		let event = pushAsRunLog({
			studioId:			rundown.studioId,
			rundownId:		rundown._id,
			segmentId:			partInstance.segmentId,
			partId:		pieceInstance.partId,
			pieceId:	pieceInstance.pieceId,
			content:			IBlueprintAsRunLogEventContent.STOPPEDPLAYBACK,
			content2: 			'piece'
		}, !!rundown.rehearsal, timestamp)
		if (event) handleEvent(event)
	} else logger.error(`rundown "${pieceInstance.rundownId}" not found in reportPieceInstanceHasStopped "${pieceInstance._id}"`)
}
