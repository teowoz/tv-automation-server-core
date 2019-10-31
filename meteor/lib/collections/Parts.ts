import * as _ from 'underscore'
import { TransformedCollection, FindOptions, MongoSelector } from '../typings/meteor'
import { Rundowns } from './Rundowns'
import { Piece, Pieces } from './Pieces'
import { AdLibPieces } from './AdLibPieces'
import { Segments } from './Segments'
import { applyClassToDocument, registerCollection, normalizeArray } from '../lib'
import { RundownAPI } from '../api/rundown'
import { checkPieceContentStatus } from '../mediaObjects'
import { Meteor } from 'meteor/meteor'
import {
	IBlueprintPart,
	PartHoldMode,
} from 'tv-automation-sofie-blueprints-integration'
import { PartNote, NoteType } from '../api/notes'
import { createMongoCollection } from './lib'

/** A "Line" in NRK Lingo. */
export interface DBPart extends IBlueprintPart {
	_id: string
	/** The segment ("Title") this line belongs to */
	segmentId: string

	/** Position inside the segment */
	_rank: number

	/** The rundown this line belongs to */
	rundownId: string

	status?: string

	/** Holds notes (warnings / errors) thrown by the blueprints during creation */
	notes?: Array<PartNote>
}

export class Part implements DBPart {

	// From IBlueprintPart:
	public externalId: string
	public title: string
	public metaData?: {
		[key: string]: any
	}
	public autoNext?: boolean
	public autoNextOverlap?: number
	public prerollDuration?: number
	public transitionPrerollDuration?: number | null
	public transitionKeepaliveDuration?: number | null
	public transitionDuration?: number | null
	public disableOutTransition?: boolean
	public expectedDuration?: number
	public typeVariant: string
	public subTypeVariant?: string
	public holdMode?: PartHoldMode
	public shouldNotifyCurrentPlayingPart?: boolean
	public classes?: string[]
	public classesForNext?: string[]
	public displayDurationGroup?: string
	public displayDuration?: number
	public invalid?: boolean
	// From DBPart:
	public _id: string
	public segmentId: string
	public _rank: number
	public rundownId: string
	public status?: string
	public notes?: Array<PartNote>

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
				sort: { _rank: 1, name: 1 }
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
					const st = checkPieceContentStatus(piece, part, studio ? studio.settings : undefined)
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
}

export const Parts: TransformedCollection<Part, DBPart>
	= createMongoCollection<Part>('parts', { transform: (doc) => applyClassToDocument(Part, doc) })
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
