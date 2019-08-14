import { Meteor } from 'meteor/meteor'
import * as _ from 'underscore'
import { logger } from '../../logging'
import { Rundown, Rundowns, RundownHoldState, DBRundown } from '../../../lib/collections/Rundowns'
import { Pieces } from '../../../lib/collections/Pieces'
import { Parts, DBPart, Part } from '../../../lib/collections/Parts'
import {
	asyncCollectionUpdate,
	getCurrentTime,
	waitForPromiseAll,
	asyncCollectionRemove,
	Time,
	pushOntoPath,
	clone
} from '../../../lib/lib'
import { TimelineObjGeneric } from '../../../lib/collections/Timeline'
import { loadCachedIngestSegment } from '../ingest/ingestCache'
import { updateSegmentFromIngestData } from '../ingest/rundownInput'
import { updateSourceLayerInfinitesAfterPart } from './infinites'
import { Studios } from '../../../lib/collections/Studios'
import { DBSegment, Segments } from '../../../lib/collections/Segments'
import { RundownPlaylist, RundownPlaylists } from '../../../lib/collections/RundownPlaylists'

/**
 * Reset the rundown:
 * Remove all dynamically inserted/updated pieces, parts, timings etc..
 */
export function resetRundownPlaylist (rundownPlaylist: RundownPlaylist) {
	logger.info('resetRundown ' + rundownPlaylist._id)
	// Remove all dunamically inserted pieces (adlibs etc)
	const rundowns = rundownPlaylist.getRundowns()
	const rundownIDs = rundowns.map(i => i._id)
	const rundownLookup = _.object(rundowns.map(i => [ i._id, i ])) as { [key: string]: Rundown }

	Pieces.remove({
		rundownId: {
			$in: rundownIDs
		},
		dynamicallyInserted: true
	})

	Parts.remove({
		rundownId: {
			$in: rundownIDs
		},
		dynamicallyInserted: true
	})

	Parts.update({
		rundownId: {
			$in: rundownIDs
		}
	}, {
		$unset: {
			duration: 1,
			previousPartEndState: 1,
			startedPlayback: 1,
			timings: 1,
			runtimeArguments: 1,
			stoppedPlayback: 1
		}
	}, { multi: true })

	const dirtyParts = Parts.find({
		rundownId: {
			$in: rundownIDs
		},
		dirty: true
	}).fetch()
	dirtyParts.forEach(part => {
		refreshPart(rundownLookup[part.rundownId], part)
		Parts.update(part._id, {$unset: {
			dirty: 1
		}})
	})

	// Reset all pieces that were modified for holds
	Pieces.update({
		rundownId: {
			$in: rundownIDs
		},
		extendOnHold: true,
		infiniteId: { $exists: true },
	}, {
		$unset: {
			infiniteId: 0,
			infiniteMode: 0,
		}
	}, { multi: true })

	// Reset any pieces that were modified by inserted adlibs
	Pieces.update({
		rundownId: {
			$in: rundownIDs
		},
		originalInfiniteMode: { $exists: true }
	}, {
		$rename: {
			originalInfiniteMode: 'infiniteMode'
		}
	}, { multi: true })

	Pieces.update({
		rundownId: {
			$in: rundownIDs
		}
	}, {
		$unset: {
			playoutDuration: 1,
			startedPlayback: 1,
			userDuration: 1,
			disabled: 1,
			hidden: 1
		}
	}, { multi: true })

	// ensure that any removed infinites are restored
	rundowns.map(r => updateSourceLayerInfinitesAfterPart(r))

	resetRundownPlaylistPlayhead(rundownPlaylist)
}
function resetRundownPlaylistPlayhead (rundownPlaylist: RundownPlaylist) {
	logger.info('resetRundownPlayhead ' + rundownPlaylist._id)
	const rundowns = rundownPlaylist.getRundowns()
	const rundown = _.first(rundowns)
	if (!rundown) throw new Meteor.Error(406, `The rundown playlist was empty, could not find a suitable part.`)
	const parts = rundown.getParts()

	RundownPlaylists.update(rundownPlaylist._id, {
		$set: {
			previousPartId: null,
			currentPartId: null,
			updateStoryStatus: null,
			holdState: RundownHoldState.NONE,
		}, $unset: {
			startedPlayback: 1,
			previousPersistentState: 1
		}
	})

	Rundowns.update({
		playlistId: rundownPlaylist._id
	}, {
		$unset: {
			startedPlayback: 1
		}
	}, {
		multi: true
	})

	if (rundownPlaylist.active) {
		// put the first on queue:
		setNextPart(rundownPlaylist, _.first(parts) || null)
	} else {
		setNextPart(rundownPlaylist, null)
	}
}
export function getPreviousPartForSegment (rundownId: string, dbSegment: DBSegment): Part | undefined {
	const prevSegment = Segments.findOne({
		rundownId: rundownId,
		_rank: { $lt: dbSegment._rank }
	}, { sort: { _rank: -1 } })
	if (prevSegment) {
		return Parts.findOne({
			rundownId: rundownId,
			segmentId: prevSegment._id,
		}, { sort: { _rank: -1 } })
	}
	return undefined
}
function getPreviousPart (dbRundown: DBRundown, dbPart: DBPart) {
	return Parts.findOne({
		rundownId: dbRundown._id,
		_rank: { $lt: dbPart._rank }
	}, { sort: { _rank: -1 } })
}
export function refreshPart (dbRundown: DBRundown, dbPart: DBPart) {
	const ingestSegment = loadCachedIngestSegment(dbRundown._id, dbRundown.externalId, dbPart.segmentId, dbPart.segmentId)

	const studio = Studios.findOne(dbRundown.studioId)
	if (!studio) throw new Meteor.Error(404, `Studio ${dbRundown.studioId} was not found`)
	const rundown = new Rundown(dbRundown)

	updateSegmentFromIngestData(studio, rundown, ingestSegment)

	const segment = Segments.findOne(dbPart.segmentId)
	if (!segment) throw new Meteor.Error(404, `Segment ${dbPart.segmentId} was not found`)

	const prevPart = getPreviousPartForSegment(dbRundown._id, segment)
	updateSourceLayerInfinitesAfterPart(rundown, prevPart)
}
export function setNextPart (
	rundownPlaylist: RundownPlaylist,
	nextPart: DBPart | null,
	setManually?: boolean,
	nextTimeOffset?: number | undefined
) {
	let ps: Array<Promise<any>> = []
	if (nextPart) {
		const acceptableRundowns = rundownPlaylist.getRundownIDs()
		if (acceptableRundowns.indexOf(nextPart.rundownId) < 0) throw new Meteor.Error(409, `Part "${nextPart._id}" not part of any rundown in playlist "${rundownPlaylist._id}"`)
		if (nextPart._id === rundownPlaylist.currentPartId) {
			throw new Meteor.Error(402, 'Not allowed to Next the currently playing Part')
		}
		if (nextPart.invalid) {
			throw new Meteor.Error(400, 'Part is marked as invalid, cannot set as next.')
		}

		ps.push(resetPart(nextPart))

		ps.push(asyncCollectionUpdate(RundownPlaylists, rundownPlaylist._id, {
			$set: {
				nextPartId: nextPart._id,
				nextPartManual: !!setManually,
				nextTimeOffset: nextTimeOffset || null
			}
		}))
		ps.push(asyncCollectionUpdate(Parts, nextPart._id, {
			$push: {
				'timings.next': getCurrentTime()
			}
		}))
	} else {
		ps.push(asyncCollectionUpdate(RundownPlaylists, rundownPlaylist._id, {
			$set: {
				nextPartId: null,
				nextPartManual: !!setManually
			}
		}))
	}
	waitForPromiseAll(ps)
}

function resetPart (part: DBPart): Promise<void> {
	let ps: Array<Promise<any>> = []

	let isDirty = part.dirty || false

	ps.push(asyncCollectionUpdate(Parts, {
		rundownId: part.rundownId,
		_id: part._id
	}, {
		$unset: {
			duration: 1,
			previousPartEndState: 1,
			startedPlayback: 1,
			runtimeArguments: 1,
			dirty: 1,
			stoppedPlayback: 1
		}
	}))
	ps.push(asyncCollectionUpdate(Pieces, {
		rundownId: part.rundownId,
		partId: part._id
	}, {
		$unset: {
			startedPlayback: 1,
			userDuration: 1,
			disabled: 1,
			hidden: 1
		}
	}, {
		multi: true
	}))
	// remove parts that have been dynamically queued for after this part (queued adLibs)
	ps.push(asyncCollectionRemove(Parts, {
		rundownId: part.rundownId,
		afterPart: part._id,
		dynamicallyInserted: true
	}))

	// Remove all pieces that have been dynamically created (such as adLib pieces)
	ps.push(asyncCollectionRemove(Pieces, {
		rundownId: part.rundownId,
		partId: part._id,
		dynamicallyInserted: true
	}))

	// Reset any pieces that were modified by inserted adlibs
	ps.push(asyncCollectionUpdate(Pieces, {
		rundownId: part.rundownId,
		partId: part._id,
		originalInfiniteMode: { $exists: true }
	}, {
		$rename: {
			originalInfiniteMode: 'infiniteMode'
		}
	}, {
		multi: true
	}))

	if (isDirty) {
		return new Promise((resolve, reject) => {
			const rundown = Rundowns.findOne(part.rundownId)
			if (!rundown) throw new Meteor.Error(404, `Rundown "${part.rundownId}" not found!`)

			Promise.all(ps)
			.then(() => {
				refreshPart(rundown, part)
				resolve()
			}).catch((e) => reject())
		})
	} else {
		const rundown = Rundowns.findOne(part.rundownId)
		if (!rundown) throw new Meteor.Error(404, `Rundown "${part.rundownId}" not found!`)
		const prevPart = getPreviousPart(rundown, part)

		return Promise.all(ps)
		.then(() => {
			updateSourceLayerInfinitesAfterPart(rundown, prevPart)
			// do nothing
		})
	}
}
export function onPartHasStoppedPlaying (part: Part, stoppedPlayingTime: Time) {
	const lastStartedPlayback = part.getLastStartedPlayback()
	if (part.startedPlayback && lastStartedPlayback && lastStartedPlayback > 0) {
		Parts.update(part._id, {
			$set: {
				duration: stoppedPlayingTime - lastStartedPlayback
			}
		})
		part.duration = stoppedPlayingTime - lastStartedPlayback
		pushOntoPath(part, 'timings.stoppedPlayback', stoppedPlayingTime)
	} else {
		// logger.warn(`Part "${part._id}" has never started playback on rundown "${rundownId}".`)
	}
}
export function prefixAllObjectIds<T extends TimelineObjGeneric> (objList: T[], prefix: string): T[] {
	const idMap: { [oldId: string]: string | undefined } = {}
	_.each(objList, o => {
		if (!o.originalId) {
			o.originalId = o.id
		}
		idMap[o.id] = prefix + o.originalId
	})

	let replaceIds = (str: string) => {
		return str.replace(/#([a-zA-Z0-9_]+)/g, (m) => {
			const id = m.substr(1, m.length - 1)
			return `#${idMap[id] || id}`
		})
	}

	return objList.map(i => {
		const o = clone(i)

		if (!o.originalId) {
			o.originalId = o.id
		}
		o.id = prefix + o.originalId

		for (const key of _.keys(o.enable)) {
			if (typeof o.enable[key] === 'string') {
				o.enable[key] = replaceIds(o.enable[key])
			}
		}

		if (typeof o.inGroup === 'string') {
			o.inGroup = idMap[o.inGroup] || o.inGroup
		}

		return o
	})
}
