import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as $ from 'jquery'

import { ISourceLayerUi, IOutputLayerUi, SegmentUi, SegmentLineUi, SegmentLineItemUi } from '../SegmentTimelineContainer'

import { FloatingInspector } from '../../FloatingInspector'

import * as ClassNames from 'classnames'
import { CustomLayerItemRenderer } from './CustomLayerItemRenderer'

export class MicSourceRenderer extends CustomLayerItemRenderer {
	itemPosition: number
	itemWidth: number
	itemElement: HTMLDivElement
	lineItem: JQuery<HTMLDivElement>
	linePosition: number

	constructor (props) {
		super(props)
	}

	repositionLine = () => {
		this.lineItem.css('left', this.linePosition + 'px')
	}

	componentDidMount () {
		// Create line element
		this.lineItem = $('<div class="segment-timeline__layer-item-appendage script-line"></div>') as JQuery<HTMLDivElement>
	}

	componentDidUpdate () {
		// Move the line element
		if (this.itemElement !== this.props.itemElement) {
			if (this.itemElement) {
				this.lineItem.remove()
			}
			this.itemElement = this.props.itemElement
			$(this.props.itemElement).parent().parent().append(this.lineItem)
		}
		if (this.itemElement) {
			// Update sizing information
			this.itemPosition = $(this.itemElement).position().left || 0
			this.itemWidth = $(this.itemElement).outerWidth() || 0

			if (this.itemPosition + this.itemWidth !== this.linePosition) {
				this.linePosition = this.itemPosition + this.itemWidth
				this.repositionLine()
			}
		}
	}

	componentWillUnmount () {
		// Remove the line element
		this.lineItem.remove()
	}

	render () {
		let labelItems = this.props.segmentLineItem.name.split('||')
		let begin = labelItems[0] || ''
		let end = labelItems[1] || ''

		return [
			<span className='segment-timeline__layer-item__label first-words' key={this.props.segmentLineItem._id + '-start'}>
				{begin}
			</span>,
			<span className='segment-timeline__layer-item__label last-words' key={this.props.segmentLineItem._id + '-finish'}>
				{end}
			</span>,
			<FloatingInspector key={this.props.segmentLineItem._id + '-inspector'}
				shown={this.props.showMiniInspector && this.props.itemElement !== undefined}>
				<div className='segment-timeline__mini-inspector' style={this.getFloatingInspectorStyle()}>
					Manus
				</div>
			</FloatingInspector>
		]
	}
}
