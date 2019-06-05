import { Mongo } from 'meteor/mongo'
import * as _ from 'underscore'
import { TransformedCollection } from '../typings/meteor'
import { applyClassToDocument, Time, registerCollection, literal, Omit } from '../lib'
import { Meteor } from 'meteor/meteor'
import {
	BlueprintRuntimeArguments,
	IBlueprintPartDBTimings,
} from 'tv-automation-sofie-blueprints-integration'
import { DBPartBase, PartBase, DBPart } from './Parts'

export interface DBPartInstance extends DBPartBase {
	_id: string
	partId: string

	/** Set when this instance has been reset, and was for a previous playthrough */
	isReset?: boolean

	/** Whether the instance has started playback
	 * This is set from a callback from the playout gateway
	 */
	startedPlayback?: number // TODO - flatten out timings obj
	/** Whether the instance has stopped playback
	 * This is set from a callback from the playout gateway
	 */
	stoppedPlayback?: number // TODO - flatten out timings obj

	nextTime?: number
	takeTime?: number // TODO - flatten out timings obj
	playOffset?: number // TODO - flatten out timings obj
	takeDone?: number

	/** The time the system played back this part, null if not yet finished playing, in milliseconds.
	 * This is set when Take:ing the next part
	 */
	duration?: number // TODO - remove and replace uses with stoppedPlayback - startedPlayback?

	/** if the part is inserted after another (for adlibbing) */
	afterPart?: string
	/** if the part was dunamically inserted (adlib) */
	dynamicallyInserted?: boolean

	/** Runtime blueprint arguments allows Sofie-side data to be injected into the blueprint for an part */
	runtimeArguments?: BlueprintRuntimeArguments
	/** An part should be marked as `dirty` if the part blueprint has been injected with runtimeArguments */
	dirty?: boolean // TODO - remove
}
export interface PartTimings extends IBlueprintPartDBTimings {
	// TODO: remove these, as they are duplicates with IBlueprintPartDBTimings

	/** Point in time the Part stopped playing (ie the time of the playout) */
	stoppedPlayback: Array<Time>,
	/** Point in time the Part was set as Next (ie the time of the user action) */
	next: Array<Time>,
	/** The playback offset that was set for the last take */
	playOffset: Array<Time>
}

export class PartInstance extends PartBase implements DBPartInstance {
	public _id: string
	public partId: string
	public isReset?: boolean

	public startedPlayback?: number
	public stoppedPlayback?: number
	public playOffset?: number
	public nextTime?: number
	public takeTime?: number
	public takeDone?: number

	public duration?: number
	public timings?: PartTimings // TOD remove
	public afterPart?: string
	public dirty?: boolean

	public runtimeArguments?: BlueprintRuntimeArguments

	constructor (document: DBPartInstance) {
		super(document)
	}

	static FromPart (part: DBPart) {
		return new PartInstance(literal<DBPartInstance>({
			...part,
			partId: part._id,
			_id: ''
		}))
	}
}

export const PartInstances: TransformedCollection<PartInstance, DBPartInstance>
	= new Mongo.Collection<PartInstance>('partInstances', { transform: (doc) => applyClassToDocument(PartInstance, doc) })
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
	}
})
