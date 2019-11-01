import * as _ from 'underscore'
import { Time, applyClassToDocument, getCurrentTime, registerCollection, normalizeArray, waitForPromiseAll, makePromise, waitForPromiseAll2 } from '../lib'
import { Segments, DBSegment, Segment } from './Segments'
import { Parts, Part } from './Parts'
import { FindOptions, MongoSelector, TransformedCollection } from '../typings/meteor'
import { Studios, Studio } from './Studios'
import { Pieces, Piece } from './Pieces'
import { Meteor } from 'meteor/meteor'
import { AdLibPieces } from './AdLibPieces'
import { RundownBaselineObjs } from './RundownBaselineObjs'
import { RundownBaselineAdLibPieces } from './RundownBaselineAdLibPieces'
import { IBlueprintRundownDB, TimelinePersistentState } from 'tv-automation-sofie-blueprints-integration'
import { ShowStyleCompound, getShowStyleCompound } from './ShowStyleVariants'
import { ShowStyleBase, ShowStyleBases } from './ShowStyleBases'
import { RundownNote } from '../api/notes'
import { IngestDataCache } from './IngestDataCache'
import { ExpectedMediaItems } from './ExpectedMediaItems'
import { createMongoCollection } from './lib'
import { PartInstance, PartInstances } from './PartInstances'
import { PieceInstance, PieceInstances } from './PieceInstances'

export enum RundownHoldState {
	NONE = 0,
	PENDING = 1, // During STK
	ACTIVE = 2, // During full, STK is played
	COMPLETE = 3, // During full, full is played
}

export interface RundownImportVersions {
	studio: string
	showStyleBase: string
	showStyleVariant: string
	blueprint: string

	core: string
}

/** This is a very uncomplete mock-up of the Rundown object */
export interface DBRundown extends IBlueprintRundownDB {
	/** The id of the Studio this rundown is in */
	studioId: string

	/** The ShowStyleBase this Rundown uses (its the parent of the showStyleVariant) */
	showStyleBaseId: string
	/** The peripheral device the rundown originates from */
	peripheralDeviceId: string
	created: Time
	modified: Time

	/** Revisions/Versions of various docs that when changed require the user to reimport the rundown */
	importVersions: RundownImportVersions

	status?: string
	airStatus?: string
	// There should be something like a Owner user here somewhere?
	/** Whether the rundown is active or not */
	active?: boolean
	/** Whether the rundown is active in rehearsal or not */
	rehearsal?: boolean
	/** the id of the Live Part - if empty, no part in this rundown is live */
	currentPartInstanceId: string | null
	/** the id of the Next Part - if empty, no segment will follow Live Part */
	nextPartInstanceId: string | null
	/** The time offset of the next line */
	nextTimeOffset?: number | null
	/** if nextPartId was set manually (ie from a user action) */
	nextPartManual?: boolean
	/** the id of the Previous Part */
	previousPartInstanceId: string | null

	/** Actual time of playback starting */
	startedPlayback?: Time

	/** Is the rundown in an unsynced (has been unpublished from ENPS) state? */
	unsynced?: boolean
	/** Timestamp of when rundown was unsynced */
	unsyncedTime?: Time

	/** Last sent storyStatus to ingestDevice (MOS) */
	notifiedCurrentPlayingPartExternalId?: string

	holdState?: RundownHoldState
	/** What the source of the data was */
	dataSource: string

	/** Holds notes (warnings / errors) thrown by the blueprints during creation, or appended after */
	notes?: Array<RundownNote>

	/** Previous state persisted from ShowStyleBlueprint.onTimelineGenerate */
	previousPersistentState?: TimelinePersistentState
}
export class Rundown implements DBRundown {
	// From IBlueprintRundown:
	public externalId: string
	public name: string
	public expectedStart?: Time
	public expectedDuration?: number
	public metaData?: {
		[key: string]: any
	}
	// From IBlueprintRundownDB:
	public _id: string
	public showStyleVariantId: string
	// From DBRundown:
	public studioId: string
	public showStyleBaseId: string
	public peripheralDeviceId: string
	public created: Time
	public modified: Time
	public importVersions: RundownImportVersions
	public status?: string
	public airStatus?: string
	public active?: boolean
	public rehearsal?: boolean
	public currentPartInstanceId: string | null
	public nextPartInstanceId: string | null
	public nextTimeOffset?: number | null
	public nextPartManual?: boolean
	public previousPartInstanceId: string | null
	public startedPlayback?: Time
	public unsynced?: boolean
	public unsyncedTime?: Time
	public notifiedCurrentPlayingPartExternalId?: string
	public holdState?: RundownHoldState
	public dataSource: string
	public notes?: Array<RundownNote>
	public previousPersistentState?: TimelinePersistentState
	_: any

	constructor (document: DBRundown) {
		_.each(_.keys(document), (key) => {
			this[key] = document[key]
		})
	}
	getShowStyleCompound (): ShowStyleCompound {

		if (!this.showStyleVariantId) throw new Meteor.Error(500, 'Rundown has no show style attached!')
		let ss = getShowStyleCompound(this.showStyleVariantId)
		if (ss) {
			return ss
		} else throw new Meteor.Error(404, `ShowStyle "${this.showStyleVariantId}" not found!`)
	}
	getShowStyleBase (): ShowStyleBase {
		let showStyleBase = ShowStyleBases.findOne(this.showStyleBaseId)
		if (!showStyleBase) throw new Meteor.Error(404, `ShowStyleBase "${this.showStyleBaseId}" not found!`)
		return showStyleBase
	}
	getStudio (): Studio {
		if (!this.studioId) throw new Meteor.Error(500,'Rundown is not in a studio!')
		let studio = Studios.findOne(this.studioId)
		if (studio) {
			return studio

		} else throw new Meteor.Error(404, 'Studio "' + this.studioId + '" not found!')
	}
	getSegments (selector?: MongoSelector<DBSegment>, options?: FindOptions) {
		selector = selector || {}
		options = options || {}
		return Segments.find(
			_.extend({
				rundownId: this._id
			}, selector),
			_.extend({
				sort: { _rank: 1 }
			}, options)
		).fetch()
	}
	getParts (selector?: MongoSelector<Part>, options?: FindOptions) {
		selector = selector || {}
		options = options || {}
		return Parts.find(
			_.extend({
				rundownId: this._id
			}, selector),
			_.extend({
				sort: { _rank: 1 }
			}, options)
		).fetch()
	}
	getActivePartInstances (selector?: MongoSelector<PartInstance>, options?: FindOptions) {
		selector = selector || {}
		options = options || {}
		return PartInstances.find(
			_.extend({
				rundownId: this._id,
				reset: { $ne: true }
			}, selector),
			_.extend({
				sort: { _rank: 1 }
			}, options)
		).fetch()
	}
	remove () {
		if (!Meteor.isServer) throw new Meteor.Error('The "remove" method is available server-side only (sorry)')
		Rundowns.remove(this._id)
		Segments.remove({ rundownId: this._id })
		Parts.remove({ rundownId: this._id })
		PartInstances.remove({ rundownId: this._id })
		Pieces.remove({ rundownId: this._id })
		AdLibPieces.remove({ rundownId: this._id })
		RundownBaselineObjs.remove({ rundownId: this._id })
		RundownBaselineAdLibPieces.remove({ rundownId: this._id })
		IngestDataCache.remove({ rundownId: this._id })
		ExpectedMediaItems.remove({ rundownId: this._id })
	}
	touch () {
		if (getCurrentTime() - this.modified > 3600 * 1000) {
			Rundowns.update(this._id, { $set: { modified: getCurrentTime() } })
		}
	}
	// getTimings () {
	// 	let timings: Array<{
	// 		time: Time,
	// 		type: string,
	// 		part: string,
	// 		elapsed: Time
	// 	}> = []
	// 	_.each(this.getParts(), (part: Part) => {
	// 		_.each(part.getTimings(), (t) => {

	// 			timings.push({
	// 				time: t.time,
	// 				elapsed: t.elapsed,
	// 				type: t.type,
	// 				part: part._id
	// 			})
	// 		})
	// 	})
	// 	return timings
	// }
	fetchAllPlayoutData (): PlayoutRundownData {

		// Do fetches in parallell:
		// const ps = [
		// 	,
		// ]
		const r = waitForPromiseAll2(makePromise(() => {
			let segments = this.getSegments()
			let segmentsMap = normalizeArray(segments, '_id')
			return { segments, segmentsMap }
		}),
		makePromise(() => {
			let parts = _.map(this.getParts(), (part) => {
				// Override member function to use cached data instead:
				part.getAllPieces = () => {
					return _.map(_.filter(pieces, (piece) => {
						return (
							piece.partId === part._id
						)
					}), (part) => {
						return _.clone(part)
					})
				}
				return part

			})
			let partsMap = normalizeArray(parts, '_id')
			return { parts, partsMap }
		}),
		makePromise(() => {
			return Pieces.find({ rundownId: this._id }).fetch()
		}),
		makePromise(() => {
			const partInstanceIds = _.compact([
				this.currentPartInstanceId,
				this.previousPartInstanceId,
				this.nextPartInstanceId
			])

			const pieceInstances = partInstanceIds.length ? PieceInstances.find({
				rundownId: this._id,
				partInstanceId: { $in: partInstanceIds }
			}).fetch() : []

			return pieceInstances
		}),
		makePromise(() => {
			const getAllPieceInstances = () => {
				return _.map(_.filter(selectedInstancePieces, (piece) => {
					return (
						piece.partInstanceId === this._id
					)
				}), (part) => {
					return _.clone(part)
				})
			}

			const partInstances = this.getSelectedPartInstances()
			_.each(_.keys(partInstances), (key) => {
				const partInstance = partInstances[key] as PartInstance | undefined
				if (partInstance) {
					// Override member function to use cached data instead:
					partInstance.getAllPieceInstances = () => {
						return _.map(_.filter(selectedInstancePieces, (piece) => {
							return (
								piece.partInstanceId === partInstance._id
							)
						}), (part) => {
							return _.clone(part)
						})
					}
				}
			})
			return partInstances
		}))
		// const { segments, segmentsMap } = r[0] as UnPromisify<typeof ps[0]>
		// const { parts, partsMap } = r[1] as UnPromisify<typeof ps[1]>
		const pieces = r[2]
		const selectedInstancePieces = r[3]
		// const { partInstances, partInstancesMap } = r[3] as UnPromisify<typeof ps[3]>

		return {
			rundown: this,
			...r[0],
			...r[1],
			pieces,
			...r[4],
			selectedInstancePieces,
		}
	}
	getNotes (): Array<RundownNote> {
		let notes: Array<RundownNote> = []
		notes = notes.concat(this.notes || [])

		return notes
	}
	appendNote (note: RundownNote): void {
		Rundowns.update(this._id, {$push: {
			notes: note
		}})
	}
	getSelectedPartInstances () {
		const ids = _.compact([
			this.currentPartInstanceId,
			this.previousPartInstanceId,
			this.nextPartInstanceId
		])
		const instances = ids.length > 0 ? PartInstances.find({
			rundownId: this._id,
			_id: { $in: ids }
		}).fetch() : []

		return {
			currentPartInstance: instances.find(inst => inst._id === this.currentPartInstanceId),
			nextPartInstance: instances.find(inst => inst._id === this.nextPartInstanceId),
			previousPartInstance: instances.find(inst => inst._id === this.previousPartInstanceId)
		}
	}
}
export interface PlayoutRundownData {
	rundown: Rundown
	// TODO - do we need all of this for playout?
	segments: Array<Segment>
	segmentsMap: {[id: string]: Segment | undefined}
	parts: Array<Part>
	partsMap: {[id: string]: Part | undefined}
	pieces: Array<Piece>

	currentPartInstance: PartInstance | undefined
	nextPartInstance: PartInstance | undefined
	previousPartInstance: PartInstance | undefined
	selectedInstancePieces: Array<PieceInstance>
}

// export const Rundowns = createMongoCollection<Rundown>('rundowns', {transform: (doc) => applyClassToDocument(Rundown, doc) })
export const Rundowns: TransformedCollection<Rundown, DBRundown>
	= createMongoCollection<Rundown>('rundowns', { transform: (doc) => applyClassToDocument(Rundown, doc) })
registerCollection('Rundowns', Rundowns)
Meteor.startup(() => {
	if (Meteor.isServer) {
		Rundowns._ensureIndex({
			studioId: 1,
			active: 1
		})
	}
})
