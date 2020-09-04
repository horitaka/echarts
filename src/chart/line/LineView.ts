/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

// FIXME step not support polar

import * as zrUtil from 'zrender/src/core/util';
import {fromPoints} from 'zrender/src/core/bbox';
import SymbolDraw from '../helper/SymbolDraw';
import SymbolClz from '../helper/Symbol';
import lineAnimationDiff from './lineAnimationDiff';
import * as graphic from '../../util/graphic';
import * as modelUtil from '../../util/model';
import {ECPolyline, ECPolygon} from './poly';
import ChartView from '../../view/Chart';
import {prepareDataCoordInfo, getStackedOnPoint} from './helper';
import {createGridClipPath, createPolarClipPath} from '../helper/createClipPathFromCoordSys';
import LineSeriesModel, { LineSeriesOption } from './LineSeries';
import type GlobalModel from '../../model/Global';
import type ExtensionAPI from '../../ExtensionAPI';
// TODO
import Cartesian2D from '../../coord/cartesian/Cartesian2D';
import Polar from '../../coord/polar/Polar';
import type List from '../../data/List';
import type { Payload, Dictionary, ColorString, ECElement, DisplayState, ComponentOption } from '../../util/types';
import type OrdinalScale from '../../scale/Ordinal';
import type Axis2D from '../../coord/cartesian/Axis2D';
import { CoordinateSystemClipArea } from '../../coord/CoordinateSystem';
import { setStatesStylesFromModel, setStatesFlag, enableHoverEmphasis } from '../../util/states';
import { getECData } from '../../util/ecData';
import Displayable from 'zrender/src/graphic/Displayable';
import {makeInner} from '../../util/model';
import ComponentModel from '../../model/Component';

const inner = makeInner<{
    defaultOption: ComponentOption
}, graphic.Text>();

type PolarArea = ReturnType<Polar['getArea']>;
type Cartesian2DArea = ReturnType<Cartesian2D['getArea']>;

interface SymbolExtended extends SymbolClz {
    __temp: boolean
}

function isPointsSame(points1: number[][], points2: number[][]) {
    if (points1.length !== points2.length) {
        return;
    }
    for (let i = 0; i < points1.length; i++) {
        const p1 = points1[i];
        const p2 = points2[i];
        if (p1[0] !== p2[0] || p1[1] !== p2[1]) {
            return;
        }
    }
    return true;
}

function getBoundingDiff(points1: number[][], points2: number[][]): number {
    const min1 = [] as number[];
    const max1 = [] as number[];

    const min2 = [] as number[];
    const max2 = [] as number[];

    fromPoints(points1, min1, max1);
    fromPoints(points2, min2, max2);

    // Get a max value from each corner of two boundings.
    return Math.max(
        Math.abs(min1[0] - min2[0]),
        Math.abs(min1[1] - min2[1]),

        Math.abs(max1[0] - max2[0]),
        Math.abs(max1[1] - max2[1])
    );
}

function getSmooth(smooth: number | boolean) {
    return typeof smooth === 'number' ? smooth : (smooth ? 0.5 : 0);
}

function getStackedOnPoints(
    coordSys: Cartesian2D | Polar,
    data: List,
    dataCoordInfo: ReturnType<typeof prepareDataCoordInfo>
) {
    if (!dataCoordInfo.valueDim) {
        return [];
    }

    const points = [];
    for (let idx = 0, len = data.count(); idx < len; idx++) {
        points.push(getStackedOnPoint(dataCoordInfo, coordSys, data, idx));
    }

    return points;
}

function turnPointsIntoStep(
    points: number[][],
    coordSys: Cartesian2D | Polar,
    stepTurnAt: 'start' | 'end' | 'middle'
) {
    const baseAxis = coordSys.getBaseAxis();
    const baseIndex = baseAxis.dim === 'x' || baseAxis.dim === 'radius' ? 0 : 1;

    const stepPoints = [];
    let i = 0;
    for (; i < points.length - 1; i++) {
        const nextPt = points[i + 1];
        const pt = points[i];
        stepPoints.push(pt);

        const stepPt = [];
        switch (stepTurnAt) {
            case 'end':
                stepPt[baseIndex] = nextPt[baseIndex];
                stepPt[1 - baseIndex] = pt[1 - baseIndex];
                // default is start
                stepPoints.push(stepPt);
                break;
            case 'middle':
                // default is start
                const middle = (pt[baseIndex] + nextPt[baseIndex]) / 2;
                const stepPt2 = [];
                stepPt[baseIndex] = stepPt2[baseIndex] = middle;
                stepPt[1 - baseIndex] = pt[1 - baseIndex];
                stepPt2[1 - baseIndex] = nextPt[1 - baseIndex];
                stepPoints.push(stepPt);
                stepPoints.push(stepPt2);
                break;
            default:
                stepPt[baseIndex] = pt[baseIndex];
                stepPt[1 - baseIndex] = nextPt[1 - baseIndex];
                // default is start
                stepPoints.push(stepPt);
        }
    }
    // Last points
    points[i] && stepPoints.push(points[i]);
    return stepPoints;
}

function getVisualGradient(
    data: List,
    coordSys: Cartesian2D | Polar
) {
    const visualMetaList = data.getVisual('visualMeta');
    if (!visualMetaList || !visualMetaList.length || !data.count()) {
        // When data.count() is 0, gradient range can not be calculated.
        return;
    }

    if (coordSys.type !== 'cartesian2d') {
        if (__DEV__) {
            console.warn('Visual map on line style is only supported on cartesian2d.');
        }
        return;
    }

    let coordDim: 'x' | 'y';
    let visualMeta;

    for (let i = visualMetaList.length - 1; i >= 0; i--) {
        const dimIndex = visualMetaList[i].dimension;
        const dimName = data.dimensions[dimIndex];
        const dimInfo = data.getDimensionInfo(dimName);
        coordDim = (dimInfo && dimInfo.coordDim) as 'x' | 'y';
        // Can only be x or y
        if (coordDim === 'x' || coordDim === 'y') {
            visualMeta = visualMetaList[i];
            break;
        }
    }

    if (!visualMeta) {
        if (__DEV__) {
            console.warn('Visual map on line style only support x or y dimension.');
        }
        return;
    }

    // If the area to be rendered is bigger than area defined by LinearGradient,
    // the canvas spec prescribes that the color of the first stop and the last
    // stop should be used. But if two stops are added at offset 0, in effect
    // browsers use the color of the second stop to render area outside
    // LinearGradient. So we can only infinitesimally extend area defined in
    // LinearGradient to render `outerColors`.

    const axis = coordSys.getAxis(coordDim);

    interface ColorStop {
        offset: number
        coord?: number
        color: ColorString
    }
    // dataToCoor mapping may not be linear, but must be monotonic.
    const colorStops: ColorStop[] = zrUtil.map(visualMeta.stops, function (stop) {
        return {
            offset: 0,
            coord: axis.toGlobalCoord(axis.dataToCoord(stop.value)),
            color: stop.color
        };
    });
    const stopLen = colorStops.length;
    const outerColors = visualMeta.outerColors.slice();

    if (stopLen && colorStops[0].coord > colorStops[stopLen - 1].coord) {
        colorStops.reverse();
        outerColors.reverse();
    }

    const tinyExtent = 10; // Arbitrary value: 10px
    const minCoord = colorStops[0].coord - tinyExtent;
    const maxCoord = colorStops[stopLen - 1].coord + tinyExtent;
    const coordSpan = maxCoord - minCoord;

    if (coordSpan < 1e-3) {
        return 'transparent';
    }

    zrUtil.each(colorStops, function (stop) {
        stop.offset = (stop.coord - minCoord) / coordSpan;
    });
    colorStops.push({
        offset: stopLen ? colorStops[stopLen - 1].offset : 0.5,
        color: outerColors[1] || 'transparent'
    });
    colorStops.unshift({ // notice colorStops.length have been changed.
        offset: stopLen ? colorStops[0].offset : 0.5,
        color: outerColors[0] || 'transparent'
    });

    // zrUtil.each(colorStops, function (colorStop) {
    //     // Make sure each offset has rounded px to avoid not sharp edge
    //     colorStop.offset = (Math.round(colorStop.offset * (end - start) + start) - start) / (end - start);
    // });

    const gradient = new graphic.LinearGradient(0, 0, 0, 0, colorStops, true);
    gradient[coordDim] = minCoord;
    gradient[coordDim + '2' as 'x2' | 'y2'] = maxCoord;

    return gradient;
}

function getIsIgnoreFunc(
    seriesModel: LineSeriesModel,
    data: List,
    coordSys: Cartesian2D
) {
    const showAllSymbol = seriesModel.get('showAllSymbol');
    const isAuto = showAllSymbol === 'auto';

    if (showAllSymbol && !isAuto) {
        return;
    }

    const categoryAxis = coordSys.getAxesByScale('ordinal')[0];
    if (!categoryAxis) {
        return;
    }

    // Note that category label interval strategy might bring some weird effect
    // in some scenario: users may wonder why some of the symbols are not
    // displayed. So we show all symbols as possible as we can.
    if (isAuto
        // Simplify the logic, do not determine label overlap here.
        && canShowAllSymbolForCategory(categoryAxis, data)
    ) {
        return;
    }

    // Otherwise follow the label interval strategy on category axis.
    const categoryDataDim = data.mapDimension(categoryAxis.dim);
    const labelMap: Dictionary<1> = {};

    zrUtil.each(categoryAxis.getViewLabels(), function (labelItem) {
        labelMap[labelItem.tickValue] = 1;
    });

    return function (dataIndex: number) {
        return !labelMap.hasOwnProperty(data.get(categoryDataDim, dataIndex));
    };
}

function canShowAllSymbolForCategory(
    categoryAxis: Axis2D,
    data: List
) {
    // In mose cases, line is monotonous on category axis, and the label size
    // is close with each other. So we check the symbol size and some of the
    // label size alone with the category axis to estimate whether all symbol
    // can be shown without overlap.
    const axisExtent = categoryAxis.getExtent();
    let availSize = Math.abs(axisExtent[1] - axisExtent[0]) / (categoryAxis.scale as OrdinalScale).count();
    isNaN(availSize) && (availSize = 0); // 0/0 is NaN.

    // Sampling some points, max 5.
    const dataLen = data.count();
    const step = Math.max(1, Math.round(dataLen / 5));
    for (let dataIndex = 0; dataIndex < dataLen; dataIndex += step) {
        if (SymbolClz.getSymbolSize(
                data, dataIndex
            // Only for cartesian, where `isHorizontal` exists.
            )[categoryAxis.isHorizontal() ? 1 : 0]
            // Empirical number
            * 1.5 > availSize
        ) {
            return false;
        }
    }

    return true;
}

function createLineClipPath(
    lineView: LineView,
    coordSys: Cartesian2D | Polar,
    hasAnimation: boolean,
    seriesModel: LineSeriesModel
) {
    if (coordSys.type === 'cartesian2d') {
        const labelModel = seriesModel.getModel('label');
        let showDuringLabel = labelModel.get('showDuringLabel');

        const done = showDuringLabel
            ? () => {

            }
            : null;

        const during = showDuringLabel
            ? (percent: number, clipRect: graphic.Rect) => {
                lineView._updateDuringLabel(percent, clipRect, lineView._data);
            }
            : null;

        const isHorizontal = coordSys.getBaseAxis().isHorizontal();
        const clipPath = createGridClipPath(coordSys, hasAnimation, seriesModel, done, during);
        // Expand clip shape to avoid clipping when line value exceeds axis
        if (!seriesModel.get('clip', true)) {
            const rectShape = clipPath.shape;
            const expandSize = Math.max(rectShape.width, rectShape.height);
            if (isHorizontal) {
                rectShape.y -= expandSize;
                rectShape.height += expandSize * 2;
            }
            else {
                rectShape.x -= expandSize;
                rectShape.width += expandSize * 2;
            }
        }
        return clipPath;
    }
    else {
        const labelModel = seriesModel.getModel('label');
        const showDuringLabel = labelModel.get('showDuringLabel');
        return createPolarClipPath(coordSys, hasAnimation, seriesModel);
    }

}

class LineView extends ChartView {

    static readonly type = 'line';

    _symbolDraw: SymbolDraw;

    _lineGroup: graphic.Group;
    _coordSys: Cartesian2D | Polar;

    _duringLabel: graphic.Text;

    _polyline: ECPolyline;
    _polygon: ECPolygon;

    _stackedOnPoints: number[][];
    _points: number[][];

    _step: LineSeriesOption['step'];
    _valueOrigin: LineSeriesOption['areaStyle']['origin'];

    _clipShapeForSymbol: CoordinateSystemClipArea;

    _data: List;

    init() {
        const lineGroup = new graphic.Group();

        const symbolDraw = new SymbolDraw();
        this.group.add(symbolDraw.group);

        this._symbolDraw = symbolDraw;
        this._lineGroup = lineGroup;
    }

    render(seriesModel: LineSeriesModel, ecModel: GlobalModel, api: ExtensionAPI) {
        const coordSys = seriesModel.coordinateSystem;
        const group = this.group;
        const data = seriesModel.getData();
        const lineStyleModel = seriesModel.getModel('lineStyle');
        const areaStyleModel = seriesModel.getModel('areaStyle');

        let points = data.mapArray(data.getItemLayout);

        const isCoordSysPolar = coordSys.type === 'polar';
        const prevCoordSys = this._coordSys;

        const symbolDraw = this._symbolDraw;
        let polyline = this._polyline;
        let polygon = this._polygon;

        const lineGroup = this._lineGroup;

        const hasAnimation = seriesModel.get('animation');

        const isAreaChart = !areaStyleModel.isEmpty();

        const valueOrigin = areaStyleModel.get('origin');
        const dataCoordInfo = prepareDataCoordInfo(coordSys, data, valueOrigin);

        let stackedOnPoints = getStackedOnPoints(coordSys, data, dataCoordInfo);

        const showSymbol = seriesModel.get('showSymbol');

        const isIgnoreFunc = showSymbol && !isCoordSysPolar
            && getIsIgnoreFunc(seriesModel, data, coordSys as Cartesian2D);

        // Remove temporary symbols
        const oldData = this._data;
        oldData && oldData.eachItemGraphicEl(function (el: SymbolExtended, idx) {
            if (el.__temp) {
                group.remove(el);
                oldData.setItemGraphicEl(idx, null);
            }
        });

        // Remove previous created symbols if showSymbol changed to false
        if (!showSymbol) {
            symbolDraw.remove();
        }

        group.add(lineGroup);

        // FIXME step not support polar
        const step = !isCoordSysPolar ? seriesModel.get('step') : false;
        let clipShapeForSymbol: PolarArea | Cartesian2DArea;
        if (coordSys && coordSys.getArea && seriesModel.get('clip', true)) {
            clipShapeForSymbol = coordSys.getArea();
            // Avoid float number rounding error for symbol on the edge of axis extent.
            // See #7913 and `test/dataZoom-clip.html`.
            if ((clipShapeForSymbol as Cartesian2DArea).width != null) {
                (clipShapeForSymbol as Cartesian2DArea).x -= 0.1;
                (clipShapeForSymbol as Cartesian2DArea).y -= 0.1;
                (clipShapeForSymbol as Cartesian2DArea).width += 0.2;
                (clipShapeForSymbol as Cartesian2DArea).height += 0.2;
            }
            else if ((clipShapeForSymbol as PolarArea).r0) {
                (clipShapeForSymbol as PolarArea).r0 -= 0.5;
                (clipShapeForSymbol as PolarArea).r += 0.5;
            }
        }
        this._clipShapeForSymbol = clipShapeForSymbol;
        // Initialization animation or coordinate system changed
        if (
            !(polyline && prevCoordSys.type === coordSys.type && step === this._step)
        ) {
            showSymbol && symbolDraw.updateData(data, {
                isIgnore: isIgnoreFunc,
                clipShape: clipShapeForSymbol
            });

            this._initAnimation(
                data,
                coordSys,
                clipShapeForSymbol
            );

            this._initDuringLabel(seriesModel, data, true);

            if (step) {
                // TODO If stacked series is not step
                points = turnPointsIntoStep(points, coordSys, step);
                stackedOnPoints = turnPointsIntoStep(stackedOnPoints, coordSys, step);
            }

            polyline = this._newPolyline(points);
            if (isAreaChart) {
                polygon = this._newPolygon(
                    points, stackedOnPoints
                );
            }
            lineGroup.setClipPath(
                createLineClipPath(this, coordSys, true, seriesModel)
            );
        }
        else {
            if (isAreaChart && !polygon) {
                // If areaStyle is added
                polygon = this._newPolygon(
                    points, stackedOnPoints
                );
            }
            else if (polygon && !isAreaChart) {
                // If areaStyle is removed
                lineGroup.remove(polygon);
                polygon = this._polygon = null;
            }

            // Update clipPath
            lineGroup.setClipPath(
                createLineClipPath(this, coordSys, false, seriesModel)
            );

            // Always update, or it is wrong in the case turning on legend
            // because points are not changed
            showSymbol && symbolDraw.updateData(data, {
                isIgnore: isIgnoreFunc,
                clipShape: clipShapeForSymbol
            });

            // Stop symbol animation and sync with line points
            // FIXME performance?
            data.eachItemGraphicEl(function (el) {
                el && el.stopAnimation(null, true);
            });

            // In the case data zoom triggerred refreshing frequently
            // Data may not change if line has a category axis. So it should animate nothing
            if (!isPointsSame(this._stackedOnPoints, stackedOnPoints)
                || !isPointsSame(this._points, points)
            ) {
                if (hasAnimation) {
                    this._updateAnimation(
                        data, stackedOnPoints, coordSys, api, step, valueOrigin
                    );
                }
                else {
                    // Not do it in update with animation
                    if (step) {
                        // TODO If stacked series is not step
                        points = turnPointsIntoStep(points, coordSys, step);
                        stackedOnPoints = turnPointsIntoStep(stackedOnPoints, coordSys, step);
                    }

                    polyline.setShape({
                        points: points
                    });
                    polygon && polygon.setShape({
                        points: points,
                        stackedOnPoints: stackedOnPoints
                    });
                }
            }
        }

        const visualColor = getVisualGradient(data, coordSys)
            || data.getVisual('style')[data.getVisual('drawType')];
        const focus = seriesModel.get(['emphasis', 'focus']);
        const blurScope = seriesModel.get(['emphasis', 'blurScope']);

        polyline.useStyle(zrUtil.defaults(
            // Use color in lineStyle first
            lineStyleModel.getLineStyle(),
            {
                fill: 'none',
                stroke: visualColor,
                lineJoin: 'bevel' as CanvasLineJoin
            }
        ));

        setStatesStylesFromModel(polyline, seriesModel, 'lineStyle');

        const shouldBolderOnEmphasis = seriesModel.get(['emphasis', 'lineStyle', 'width']) === 'bolder';
        if (shouldBolderOnEmphasis) {
            const emphasisLineStyle = polyline.getState('emphasis').style;
            emphasisLineStyle.lineWidth = polyline.style.lineWidth + 1;
        }

        // Needs seriesIndex for focus
        getECData(polyline).seriesIndex = seriesModel.seriesIndex;
        enableHoverEmphasis(polyline, focus, blurScope);

        const smooth = getSmooth(seriesModel.get('smooth'));
        polyline.setShape({
            smooth: smooth,
            smoothMonotone: seriesModel.get('smoothMonotone'),
            connectNulls: seriesModel.get('connectNulls')
        });

        if (polygon) {
            const stackedOnSeries = data.getCalculationInfo('stackedOnSeries');
            let stackedOnSmooth = 0;

            polygon.useStyle(zrUtil.defaults(
                areaStyleModel.getAreaStyle(),
                {
                    fill: visualColor,
                    opacity: 0.7,
                    lineJoin: 'bevel' as CanvasLineJoin
                }
            ));

            if (stackedOnSeries) {
                stackedOnSmooth = getSmooth(stackedOnSeries.get('smooth'));
            }

            polygon.setShape({
                smooth: smooth,
                stackedOnSmooth: stackedOnSmooth,
                smoothMonotone: seriesModel.get('smoothMonotone'),
                connectNulls: seriesModel.get('connectNulls')
            });

            setStatesStylesFromModel(polygon, seriesModel, 'areaStyle');
            // Needs seriesIndex for focus
            getECData(polygon).seriesIndex = seriesModel.seriesIndex;
            enableHoverEmphasis(polygon, focus, blurScope);
        }

        const changePolyState = (toState: DisplayState) => {
            this._changePolyState(toState);
        };

        data.eachItemGraphicEl(function (el) {
            // Switch polyline / polygon state if element changed its state.
            el && ((el as ECElement).onHoverStateChange = changePolyState);
        });

        this._data = data;
        // Save the coordinate system for transition animation when data changed
        this._coordSys = coordSys;
        this._stackedOnPoints = stackedOnPoints;
        this._points = points;
        this._step = step;
        this._valueOrigin = valueOrigin;
    }

    dispose() {}

    highlight(
        seriesModel: LineSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload
    ) {
        const data = seriesModel.getData();
        const dataIndex = modelUtil.queryDataIndex(data, payload);

        this._changePolyState('emphasis');

        if (!(dataIndex instanceof Array) && dataIndex != null && dataIndex >= 0) {
            let symbol = data.getItemGraphicEl(dataIndex) as SymbolClz;
            if (!symbol) {
                // Create a temporary symbol if it is not exists
                const pt = data.getItemLayout(dataIndex) as number[];
                if (!pt) {
                    // Null data
                    return;
                }
                // fix #11360: should't draw symbol outside clipShapeForSymbol
                if (this._clipShapeForSymbol && !this._clipShapeForSymbol.contain(pt[0], pt[1])) {
                    return;
                }
                symbol = new SymbolClz(data, dataIndex);
                symbol.setPosition(pt);
                symbol.setZ(
                    seriesModel.get('zlevel'),
                    seriesModel.get('z')
                );
                symbol.ignore = isNaN(pt[0]) || isNaN(pt[1]);
                (symbol as SymbolExtended).__temp = true;
                data.setItemGraphicEl(dataIndex, symbol);

                // Stop scale animation
                symbol.stopSymbolAnimation(true);

                this.group.add(symbol);
            }
            symbol.highlight();
        }
        else {
            // Highlight whole series
            ChartView.prototype.highlight.call(
                this, seriesModel, ecModel, api, payload
            );
        }
    }

    downplay(
        seriesModel: LineSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload
    ) {
        const data = seriesModel.getData();
        const dataIndex = modelUtil.queryDataIndex(data, payload) as number;

        this._changePolyState('normal');

        if (dataIndex != null && dataIndex >= 0) {
            const symbol = data.getItemGraphicEl(dataIndex) as SymbolExtended;
            if (symbol) {
                if (symbol.__temp) {
                    data.setItemGraphicEl(dataIndex, null);
                    this.group.remove(symbol);
                }
                else {
                    symbol.downplay();
                }
            }
        }
        else {
            // FIXME
            // can not downplay completely.
            // Downplay whole series
            ChartView.prototype.downplay.call(
                this, seriesModel, ecModel, api, payload
            );
        }
    }

    _changePolyState(toState: DisplayState) {
        const polygon = this._polygon;
        setStatesFlag(this._polyline, toState);
        polygon && setStatesFlag(polygon, toState);
    }

    _newPolyline(points: number[][]) {
        let polyline = this._polyline;
        // Remove previous created polyline
        if (polyline) {
            this._lineGroup.remove(polyline);
        }

        polyline = new ECPolyline({
            shape: {
                points: points
            },
            segmentIgnoreThreshold: 2,
            z2: 10
        });

        this._lineGroup.add(polyline);

        this._polyline = polyline;

        return polyline;
    }

    _newPolygon(points: number[][], stackedOnPoints: number[][]) {
        let polygon = this._polygon;
        // Remove previous created polygon
        if (polygon) {
            this._lineGroup.remove(polygon);
        }

        polygon = new ECPolygon({
            shape: {
                points: points,
                stackedOnPoints: stackedOnPoints
            },
            segmentIgnoreThreshold: 2
        });

        this._lineGroup.add(polygon);

        this._polygon = polygon;
        return polygon;
    }

    _initAnimation(
        data: List,
        coordSys: Polar | Cartesian2D,
        clipShape: PolarArea | Cartesian2DArea
    ) {
        let isHorizontalOrRadial: boolean;
        let isCoordSysPolar: boolean;
        const baseAxis = coordSys.getBaseAxis();
        if (coordSys.type === 'cartesian2d') {
            isHorizontalOrRadial = (baseAxis as Axis2D).isHorizontal();
            isCoordSysPolar = false;
        }
        else if (coordSys.type === 'polar') {
            isHorizontalOrRadial = baseAxis.dim === 'angle';
            isCoordSysPolar = true;
        }

        const seriesModel = data.hostModel;
        let seriesDuration = seriesModel.get('animationDuration');
        if (typeof seriesDuration === 'function') {
            seriesDuration = seriesDuration(null);
        }
        const seriesDalay = seriesModel.get('animationDelay') || 0;
        const seriesDalayValue = typeof seriesDalay === 'function'
            ? seriesDalay(null)
            : seriesDalay;

        data.eachItemGraphicEl(function (symbol, idx) {
            const el = (symbol as SymbolClz).childAt(0) as Displayable;
            if (el) {
                const point = [symbol.x, symbol.y];
                let start, end, current;
                if (isCoordSysPolar) {
                    const polarClip = clipShape as PolarArea;
                    const coord = (coordSys as Polar).pointToCoord(point);
                    if (isHorizontalOrRadial) {
                        start = polarClip.startAngle;
                        end = polarClip.endAngle;
                        current = -coord[1] / 180 * Math.PI;
                    }
                    else {
                        start = polarClip.r0;
                        end = polarClip.r;
                        current = coord[0];
                    }
                }
                else {
                    const gridClip = clipShape as Cartesian2DArea;
                    if (isHorizontalOrRadial) {
                        start = gridClip.x;
                        end =  gridClip.x + gridClip.width;
                        current = symbol.x;
                    }
                    else {
                        start = gridClip.y + gridClip.height;
                        end = gridClip.y;
                        current = symbol.y;
                    }
                }
                const ratio = end === start ? 0 : (current - start) / (end - start);

                let delay;
                if (typeof seriesDalay === 'function') {
                    delay = seriesDalay(idx);
                }
                else {
                    delay = (seriesDuration * ratio) + seriesDalayValue;
                }

                el.stopAnimation();

                const symbolSize = data.getItemVisual(
                    idx,
                    'symbolSize'
                );
                const symbolSizeArr = zrUtil.isArray(symbolSize)
                    ? symbolSize : [symbolSize, symbolSize];
                const lineWidth = el.style.lineWidth;

                el.attr({
                    scaleX: 1,
                    scaleY: 1,
                    style: {
                        lineWidth: 0
                    }
                });
                el.animateTo({
                    scaleX: symbolSizeArr[0] / 2,
                    scaleY: symbolSizeArr[1] / 2,
                    style: {
                        lineWidth: lineWidth
                    }
                }, {
                    duration: 200,
                    delay: delay
                });

                const text = el.getTextContent();
                if (text) {
                    const textOpacity = !text.style || text.style.opacity == null
                        ? 1
                        : text.style.opacity;
                    text.stopAnimation();
                    text.attr({
                        style: {
                            opacity: 0
                        }
                    });
                    text.animateTo({
                        style: {
                            opacity: textOpacity
                        }
                    }, {
                        duration: 300,
                        delay: delay
                    });
                }

                (el as ECElement).disableLabelAnimation = true;
            }
        });
    }

    _initDuringLabel(
        seriesModel: LineSeriesModel,
        data: List,
        isUpdate: boolean
    ) {
        const labelModel = seriesModel.getModel('label');
        const showDuringLabel = labelModel.get('showDuringLabel');

        if (showDuringLabel) {
            if (!this._duringLabel) {
                this._duringLabel = new graphic.Text({
                    style: {
                        text: 'abcd'
                    }
                });
                this.group.add(this._duringLabel);
            }

            // const defaultTextGetter = (values: ParsedValue | ParsedValue[]) => {
            //     return getDefaultLabel(seriesModel.getData(), 0, values);
            // };

            // (isUpdate ? updateLabel : initLabel)(
            //     this._duringLabel, data, 0, labelModel, seriesModel, seriesModel, defaultTextGetter
            // );
        }
    }

    _updateDuringLabel(
        percent: number,
        clipRect: graphic.Rect,
        data: List
    ) {
        console.log(percent, clipRect.shape)
        if (this._duringLabel) {
            this._duringLabel.attr({
                x: clipRect.shape.x + clipRect.shape.width + 10,
                y: 0
            });

            const baseAxis = this._coordSys.getBaseAxis();

            let splitFound = false;
            let left = null;
            data.each(function (idx) {
                const right = data.getValues(idx);
                console.log(right);
            });

            const host = inner(this._duringLabel);
        }
    }

    /**
     * @private
     */
    // FIXME Two value axis
    _updateAnimation(
        data: List,
        stackedOnPoints: number[][],
        coordSys: Cartesian2D | Polar,
        api: ExtensionAPI,
        step: LineSeriesOption['step'],
        valueOrigin: LineSeriesOption['areaStyle']['origin']
    ) {
        const polyline = this._polyline;
        const polygon = this._polygon;
        const seriesModel = data.hostModel;

        const diff = lineAnimationDiff(
            this._data, data,
            this._stackedOnPoints, stackedOnPoints,
            this._coordSys, coordSys,
            this._valueOrigin, valueOrigin
        );

        let current = diff.current;
        let stackedOnCurrent = diff.stackedOnCurrent;
        let next = diff.next;
        let stackedOnNext = diff.stackedOnNext;
        if (step) {
            // TODO If stacked series is not step
            current = turnPointsIntoStep(diff.current, coordSys, step);
            stackedOnCurrent = turnPointsIntoStep(diff.stackedOnCurrent, coordSys, step);
            next = turnPointsIntoStep(diff.next, coordSys, step);
            stackedOnNext = turnPointsIntoStep(diff.stackedOnNext, coordSys, step);
        }

        // Don't apply animation if diff is large.
        // For better result and avoid memory explosion problems like
        // https://github.com/apache/incubator-echarts/issues/12229
        if (getBoundingDiff(current, next) > 3000
            || (polygon && getBoundingDiff(stackedOnCurrent, stackedOnNext) > 3000)
        ) {
            polyline.setShape({
                points: next
            });
            if (polygon) {
                polygon.setShape({
                    points: next,
                    stackedOnPoints: stackedOnNext
                });
            }
            return;
        }

        // `diff.current` is subset of `current` (which should be ensured by
        // turnPointsIntoStep), so points in `__points` can be updated when
        // points in `current` are update during animation.
        (polyline.shape as any).__points = diff.current;
        polyline.shape.points = current;

        // Stop previous animation.
        polyline.stopAnimation();
        graphic.updateProps(polyline, {
            shape: {
                points: next
            }
        }, seriesModel);

        if (polygon) {
            polygon.setShape({
                // Reuse the points with polyline.
                points: current,
                stackedOnPoints: stackedOnCurrent
            });
            polygon.stopAnimation();
            graphic.updateProps(polygon, {
                shape: {
                    stackedOnPoints: stackedOnNext
                }
            }, seriesModel);
            // If use attr directly in updateProps.
            if (polyline.shape.points !== polygon.shape.points) {
                polygon.shape.points = polyline.shape.points;
            }
        }


        const updatedDataInfo: {
            el: SymbolExtended,
            ptIdx: number
        }[] = [];
        const diffStatus = diff.status;

        for (let i = 0; i < diffStatus.length; i++) {
            const cmd = diffStatus[i].cmd;
            if (cmd === '=') {
                const el = data.getItemGraphicEl(diffStatus[i].idx1) as SymbolExtended;
                if (el) {
                    updatedDataInfo.push({
                        el: el,
                        ptIdx: i    // Index of points
                    });
                }
            }
        }

        if (polyline.animators && polyline.animators.length) {
            polyline.animators[0].during(function () {
                for (let i = 0; i < updatedDataInfo.length; i++) {
                    const el = updatedDataInfo[i].el;
                    el.setPosition((polyline.shape as any).__points[updatedDataInfo[i].ptIdx]);
                    el.markRedraw();
                }
            });
        }
    }

    remove(ecModel: GlobalModel) {
        const group = this.group;
        const oldData = this._data;
        this._lineGroup.removeAll();
        this._symbolDraw.remove(true);
        // Remove temporary created elements when highlighting
        oldData && oldData.eachItemGraphicEl(function (el: SymbolExtended, idx) {
            if (el.__temp) {
                group.remove(el);
                oldData.setItemGraphicEl(idx, null);
            }
        });

        this._polyline =
            this._polygon =
            this._coordSys =
            this._points =
            this._stackedOnPoints =
            this._data = null;
    }
}

ChartView.registerClass(LineView);

export default ChartView;
