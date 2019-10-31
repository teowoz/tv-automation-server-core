import * as _ from 'underscore'
import { TransformedCollection } from '../typings/meteor'
import { applyClassToDocument, Time, registerCollection } from '../lib'
import { Meteor } from 'meteor/meteor'
import {
	IBlueprintPartInstance,
	BlueprintRuntimeArguments,
	IBlueprintPartInstanceTimings,
	PartEndState,
} from 'tv-automation-sofie-blueprints-integration'
import { createMongoCollection } from './lib'
import { DBPart, Part } from './Parts'


/** A "Line" in NRK Lingo. */
export interface DBPartInstance extends DBPart, IBlueprintPartInstance {
	partId: string

	// /** Whether the part has started playback (the most recent time it was played).
	//  * This is reset each time setAsNext is used.
	//  * This is set from a callback from the playout gateway
	//  */
	// startedPlayback?: boolean
	// /** Whether the part has stopped playback (the most recent time it was played & stopped).
	//  * This is set from a callback from the playout gateway
	//  */
	// stoppedPlayback?: boolean

	timings: PartInstanceTimings

	/** The time the system played back this part, null if not yet finished playing, in milliseconds.
	 * This is set when Take:ing the next part
	 */
	duration?: number // TODO - this can be replaced with timings?
	/** The end state of the previous part, to allow for bits of this to part to be based on what the previous did/was */
	previousPartEndState?: PartEndState

	/** if the part is inserted after another (for adlibbing) */
	afterPart?: string
	/** if the part was dunamically inserted (adlib) */
	dynamicallyInserted?: boolean

	/** Runtime blueprint arguments allows Sofie-side data to be injected into the blueprint for an part */
	runtimeArguments?: BlueprintRuntimeArguments
	/** An part should be marked as `dirty` if the part blueprint has been injected with runtimeArguments */
	dirty?: boolean // TODO - remove?

	/** Once a PartInstance is reset it should no longer be shown to the user. */
	reset?: boolean
}
export interface PartInstanceTimings extends IBlueprintPartInstanceTimings {
	/** The playback offset that was set for the last take */
	playOffset?: Time
}

export class PartInstance extends Part implements DBPartInstance {
	public partId: string
	// From IBlueprintPartInstance:
	public timings: PartInstanceTimings
	// From DBPart:
	// public startedPlayback?: boolean
	// public stoppedPlayback?: boolean
	public duration?: number
	public previousPartEndState?: PartEndState
	public afterPart?: string
	public dynamicallyInserted?: boolean
	public runtimeArguments?: BlueprintRuntimeArguments
	public dirty?: boolean // TODO - remove?
	public reset?: boolean

	constructor (document: DBPartInstance) {
		super(document)
	}
	// getTimings () {
	// 	// return a chronological list of timing events
	// 	let events: Array<{time: Time, type: string, elapsed: Time}> = []
	// 	_.each(['take', 'takeDone', 'startedPlayback', 'takeOut', 'stoppedPlayback', 'next'], (key) => {
	// 		if (this.timings) {
	// 			_.each(this.timings[key], (t: Time) => {
	// 				events.push({
	// 					time: t,
	// 					type: key,
	// 					elapsed: 0
	// 				})
	// 			})
	// 		}
	// 	})
	// 	let prevEv: any = null
	// 	return _.map(
	// 		_.sortBy(events, e => e.time),
	// 		(ev) => {
	// 			if (prevEv) {
	// 				ev.elapsed = ev.time - prevEv.time
	// 			}
	// 			prevEv = ev
	// 			return ev
	// 		}
	// 	)

	// }
	// getLastTake () {
	// 	if (!this.timings) return undefined

	// 	if (!this.timings.take || this.timings.take.length === 0) return undefined

	// 	return this.timings.take[this.timings.take.length - 1]
	// }
	// getLastStartedPlayback () {
	// 	if (!this.timings) return undefined

	// 	if (!this.timings.startedPlayback || this.timings.startedPlayback.length === 0) return undefined

	// 	return this.timings.startedPlayback[this.timings.startedPlayback.length - 1]
	// }
	// getLastPlayOffset () {
	// 	if (!this.timings) return undefined

	// 	if (!this.timings.playOffset || this.timings.playOffset.length === 0) return undefined

	// 	return this.timings.playOffset[this.timings.playOffset.length - 1]
	// }
}

export function WrapPartToTemporaryInstance (part: DBPart): PartInstance {
	return new PartInstance({
		...part,
		_id: `${part._id}_tmp_instance`,
		partId: part._id,
		timings: {}
	})
}

export function FindInstanceOrWrapToTemporary (partInstances: PartInstance[], part: DBPart): PartInstance {
	return partInstances.find(instance => instance.partId === part._id) || WrapPartToTemporaryInstance(part)
}

export const PartInstances: TransformedCollection<PartInstance, DBPartInstance> = createMongoCollection<PartInstance>('partInstances', { transform: (doc) => applyClassToDocument(PartInstance, doc) })
registerCollection('PartInstances', PartInstances)
Meteor.startup(() => {
	if (Meteor.isServer) {
		PartInstances._ensureIndex({
			rundownId: 1,
			segmentId: 1,
			_rank: 1
		})
		PartInstances._ensureIndex({
			rundownId: 1,
			_rank: 1
		})
		PartInstances._ensureIndex({
			rundownId: 1,
			partId: 1,
			_rank: 1
		})
	}
})
