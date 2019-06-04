import { Mongo } from 'meteor/mongo'
import * as _ from 'underscore'
import { TransformedCollection, FindOptions, MongoSelector } from '../typings/meteor'
import { Rundowns } from './Rundowns'
import { Piece, Pieces } from './Pieces'
import { AdLibPieces } from './AdLibPieces'
import { Segments } from './Segments'
import { applyClassToDocument, Time, registerCollection, normalizeArray } from '../lib'
import { RundownAPI } from '../api/rundown'
import { checkPieceContentStatus } from '../mediaObjects'
import { Meteor } from 'meteor/meteor'
import {
	IBlueprintPartDB,
	PartHoldMode,
} from 'tv-automation-sofie-blueprints-integration'
import { PartNote, NoteType } from '../api/notes'

/** A "Line" in NRK Lingo. */
export interface DBPart extends IBlueprintPartDB {
	/** Position inside the segment */
	_rank: number

	/** The rundown this line belongs to */
	rundownId: string

	status?: string

	/** Holds notes (warnings / errors) thrown by the blueprints during creation */
	notes?: Array<PartNote>

}

export class Part implements DBPart {
	public _id: string
	public _rank: number
	public title: string
	public externalId: string
	public segmentId: string
	public rundownId: string
	public invalid: boolean
	public autoNext?: boolean
	public autoNextOverlap?: number
	public prerollDuration?: number
	public transitionPrerollDuration?: number | null
	public transitionKeepaliveDuration?: number | null
	public transitionDuration?: number | null
	public metaData?: { [key: string]: any }
	public status?: string
	public expectedDuration?: number
	public displayDuration?: number
	public displayDurationGroup?: string
	public disableOutTransition?: boolean
	public updateStoryStatus?: boolean
	public holdMode?: PartHoldMode
	public notes?: Array<PartNote>

	public typeVariant: string

	public classes?: Array<string>
	public classesForNext?: Array<string>

	constructor (document: DBPart) {
		_.each(_.keys(document), (key) => {
			this[key] = document[key]
		})
	}
	getRundown () {
		return Rundowns.findOne(this.rundownId)
	}
	getSegment () {
		return Segments.findOne(this.segmentId)
	}
	getPieces (selector?: MongoSelector<Piece>, options?: FindOptions) {
		selector = selector || {}
		options = options || {}
		return Pieces.find(
			_.extend({
				rundownId: this.rundownId,
				partId: this._id
			}, selector),
			_.extend({
				sort: { _rank: 1 }
			}, options)
		).fetch()
	}
	getAllPieces () {
		return this.getPieces()
	}

	getAdLibPieces (selector?: MongoSelector<Piece>, options?: FindOptions) {
		selector = selector || {}
		options = options || {}
		return AdLibPieces.find(
			_.extend({
				rundownId: this.rundownId,
				partId: this._id
			}, selector),
			_.extend({
				sort: { _rank: 1 }
			}, options)
		).fetch()
	}
	getNotes (runtimeNotes?: boolean): Array<PartNote> {
		let notes: Array<PartNote> = []
		notes = notes.concat(this.notes || [])

		if (runtimeNotes) {
			const pieces = this.getPieces()
			const rundown = this.getRundown()
			const studio = rundown && rundown.getStudio()
			const showStyleBase = rundown && rundown.getShowStyleBase()
			const partLookup = showStyleBase && normalizeArray(showStyleBase.sourceLayers, '_id')
			_.each(pieces, (piece) => {
				// TODO: check statuses (like media availability) here

				if (partLookup && piece.sourceLayerId && partLookup[piece.sourceLayerId]) {
					const part = partLookup[piece.sourceLayerId]
					const st = checkPieceContentStatus(piece, part, studio ? studio.config : [])
					if (st.status === RundownAPI.PieceStatusCode.SOURCE_MISSING || st.status === RundownAPI.PieceStatusCode.SOURCE_BROKEN) {
						notes.push({
							type: NoteType.WARNING,
							origin: {
								name: 'Media Check',
								rundownId: this.rundownId,
								segmentId: this.segmentId,
								partId: this._id,
								pieceId: piece._id
							},
							message: st.message || ''
						})
					}
				}
			})
		}
		return notes
	}
	getTimings () {
		// // return a chronological list of timing events
		// let events: Array<{time: Time, type: string, elapsed: Time}> = []
		// _.each(['take', 'takeDone', 'startedPlayback', 'takeOut', 'stoppedPlayback', 'next'], (key) => {
		// 	if (this.timings) {
		// 		_.each(this.timings[key], (t: Time) => {
		// 			events.push({
		// 				time: t,
		// 				type: key,
		// 				elapsed: 0
		// 			})
		// 		})
		// 	}
		// })
		// let prevEv: any = null
		// return _.map(
		// 	_.sortBy(events, e => e.time),
		// 	(ev) => {
		// 		if (prevEv) {
		// 			ev.elapsed = ev.time - prevEv.time
		// 		}
		// 		prevEv = ev
		// 		return ev
		// 	}
		// )

	}
}

export const Parts: TransformedCollection<Part, DBPart>
	= new Mongo.Collection<Part>('parts', { transform: (doc) => applyClassToDocument(Part, doc) })
registerCollection('Parts', Parts)
Meteor.startup(() => {
	if (Meteor.isServer) {
		Parts._ensureIndex({
			rundownId: 1,
			segmentId: 1,
			_rank: 1
		})
		Parts._ensureIndex({
			rundownId: 1,
			_rank: 1
		})
	}
})
