/// <reference path='../../typings/tsd.d.ts' />

namespace Charts {
  'use strict';

  declare let d3:any;
  declare let console:any;

  let debug:boolean = false;

  // the scale to use for y-axis when all values are 0, [0, DEFAULT_Y_SCALE]
  export const DEFAULT_Y_SCALE = 10;
  export const Y_AXIS_HEIGHT = 25;
  export const CHART_HEIGHT = 250;
  export const CHART_WIDTH = 750;
  export const HOVER_DATE_TIME_FORMAT = 'MM/DD/YYYY h:mm a';
  export const BAR_OFFSET = 2;
  export const margin = {top: 10, right: 5, bottom: 5, left: 90};
  export let width = CHART_WIDTH - margin.left - margin.right;


  /**
   * @ngdoc directive
   * @name hawkularChart
   * @description A d3 based charting direction to provide charting using various styles of charts.
   *
   */
  angular.module('hawkular.charts')
    .directive('hawkularChart', ['$rootScope', '$http', '$interval', '$log',
        function ($rootScope:ng.IRootScopeService,
                  $http:ng.IHttpService,
                  $interval:ng.IIntervalService,
                  $log:ng.ILogService):ng.IDirective {

          /// only for the stand alone charts
          const BASE_URL = '/hawkular/metrics';

          function link(scope, element, attrs) {



            // data specific vars
            let dataPoints:IChartDataPoint[] = [],
              multiDataPoints:IMultiDataPoint[],
              forecastDataPoints:ISimpleMetric[],
              dataUrl = attrs.metricUrl,
              metricId = attrs.metricId || '',
              metricTenantId = attrs.metricTenantId || '',
              metricType = attrs.metricType || 'gauge',
              timeRangeInSeconds = +attrs.timeRangeInSeconds || 43200,
              refreshIntervalInSeconds = +attrs.refreshIntervalInSeconds || 3600,
              alertValue = +attrs.alertValue,
              interpolation = attrs.interpolation || 'monotone',
              endTimestamp:TimeInMillis = Date.now(),
              startTimestamp:TimeInMillis = endTimestamp - timeRangeInSeconds,
              previousRangeDataPoints = [],
              annotationData = [],
              chartType = attrs.chartType || 'line',
              singleValueLabel = attrs.singleValueLabel || 'Raw Value',
              noDataLabel = attrs.noDataLabel || 'No Data',
              durationLabel = attrs.durationLabel || 'Interval',
              minLabel = attrs.minLabel || 'Min',
              maxLabel = attrs.maxLabel || 'Max',
              avgLabel = attrs.avgLabel || 'Avg',
              timestampLabel = attrs.timestampLabel || 'Timestamp',
              showAvgLine = true,
              showDataPoints = false,
              hideHighLowValues = false,
              useZeroMinValue = false;

            // chart specific vars

            let adjustedChartHeight = CHART_HEIGHT - 50,
              height = adjustedChartHeight - margin.top - margin.bottom,
              smallChartThresholdInPixels = 600,
              titleHeight = 30, titleSpace = 10,
              innerChartHeight = height + margin.top - titleHeight - titleSpace + margin.bottom,
              adjustedChartHeight2 = +titleHeight + titleSpace + margin.top,
              chartData,
              yScale,
              timeScale,
              yAxis,
              xAxis,
              tip,
              brush,
              brushGroup,
              chart,
              chartParent,
              svg,
              visuallyAdjustedMin,
              visuallyAdjustedMax,
              avg,
              peak,
              min,
              processedNewData,
              processedPreviousRangeData;

            let hasInit = false;

            dataPoints = attrs.data;
            forecastDataPoints = attrs.forecastData;
            showDataPoints = attrs.showDataPoints;
            previousRangeDataPoints = attrs.previousRangeData;
            annotationData = attrs.annotationData;

            let startIntervalPromise;


            function getChartWidth():number {
              //return angular.element('#' + chartContext.chartHandle).width();
              return CHART_WIDTH;
            }

            function useSmallCharts():boolean {
              return getChartWidth() <= smallChartThresholdInPixels;
            }


            function initialization():void {
              // destroy any previous charts
              if (chart) {
                chartParent.selectAll('*').remove();
              }
              chartParent = d3.select(element[0]);
              chart = chartParent.append('svg')
                .attr('viewBox', '0 0 760 ' + (CHART_HEIGHT + Y_AXIS_HEIGHT))
                .attr('preserveAspectRatio', 'xMinYMin meet');

              createSvgDefs(chart);

              svg = chart.append('g')
                .attr('width', width + margin.left + margin.right)
                .attr('height', innerChartHeight)
                .attr('transform', 'translate(' + margin.left + ',' + (adjustedChartHeight2) + ')');

              tip = d3.tip()
                .attr('class', 'd3-tip')
                .offset([-10, 0])
                .html((d, i) => {
                  return buildHover(d, i);
                });

              svg.call(tip);

              // a placeholder for the alerts
              svg.append('g').attr('class', 'alertHolder');

              hasInit = true;
            }


            function setupFilteredData(dataPoints:IChartDataPoint[]):void {

              if (dataPoints) {
                peak = d3.max(dataPoints.map((d) => {
                  return !isEmptyDataPoint(d) ? (d.avg || d.value) : 0;
                }));

                min = d3.min(dataPoints.map((d) => {
                  return !isEmptyDataPoint(d) ? (d.avg || d.value) : undefined;
                }));
              }

              /// lets adjust the min and max to add some visual spacing between it and the axes
              visuallyAdjustedMin = useZeroMinValue ? 0 : min * .95;
              visuallyAdjustedMax = peak + ((peak - min) * 0.2);

              /// check if we need to adjust high/low bound to fit alert value
              if (alertValue) {
                visuallyAdjustedMax = Math.max(visuallyAdjustedMax, alertValue * 1.2);
                visuallyAdjustedMin = Math.min(visuallyAdjustedMin, alertValue * .95);
              }

              /// use default Y scale in case high and low bound are 0 (ie, no values or all 0)
              visuallyAdjustedMax = !!!visuallyAdjustedMax && !!!visuallyAdjustedMin ? DEFAULT_Y_SCALE : visuallyAdjustedMax;
            }

            function determineScale(dataPoints:IChartDataPoint[]) {
              let xTicks, numberOfBarsForSmallGraph = 20;

              if (dataPoints.length > 0) {

                // if window is too small server up small chart
                if (useSmallCharts()) {
                  width = 250;
                  xTicks = 3;
                  chartData = dataPoints.slice(dataPoints.length - numberOfBarsForSmallGraph, dataPoints.length);
                }
                else {
                  //  we use the width already defined above
                  xTicks = 9;
                  chartData = dataPoints;
                }

                setupFilteredData(dataPoints);

                yScale = d3.scale.linear()
                  .clamp(true)
                  .rangeRound([height, 0])
                  .domain([visuallyAdjustedMin, visuallyAdjustedMax]);

                yAxis = d3.svg.axis()
                  .scale(yScale)
                  .ticks(5)
                  .tickSize(4, 4, 0)
                  .orient('left');

                let timeScaleMin = d3.min(dataPoints.map((d) => {
                  return d.timestamp;
                }));

                let timeScaleMax;
                if (forecastDataPoints && forecastDataPoints.length > 0) {
                  timeScaleMax = forecastDataPoints[forecastDataPoints.length - 1].timestamp;
                } else {
                  timeScaleMax = d3.max(dataPoints.map((d) => {
                    return d.timestamp;
                  }));
                }

                timeScale = d3.time.scale()
                  .range([0, width])
                  .domain([timeScaleMin, timeScaleMax]);

                xAxis = d3.svg.axis()
                  .scale(timeScale)
                  .ticks(xTicks)
                  .tickFormat(xAxisTimeFormats())
                  .tickSize(4, 4, 0)
                  .orient('bottom');

              }
            }


            function setupFilteredMultiData(multiDataPoints:IMultiDataPoint[]):any {
              let alertPeak:number,
                highPeak:number;

              function determineMultiDataMinMax() {
                let currentMax:number,
                  currentMin:number,
                  seriesMax:number,
                  seriesMin:number,
                  maxList:number[] = [],
                  minList:number[] = [];

                multiDataPoints.forEach((series) => {
                  currentMax = d3.max(series.values.map((d) => {
                    return isEmptyDataPoint(d) ? 0 : d.avg;
                  }));
                  maxList.push(currentMax);
                  currentMin = d3.min(series.values.map((d) => {
                    return !isEmptyDataPoint(d) ? d.avg : Number.MAX_VALUE;
                  }));
                  minList.push(currentMin);

                });
                seriesMax = d3.max(maxList);
                seriesMin = d3.min(minList);
                return [seriesMin, seriesMax];
              }


              const minMax = determineMultiDataMinMax();
              peak = minMax[1];
              min = minMax[0];

              visuallyAdjustedMin = useZeroMinValue ? 0 : min - (min * 0.05);
              if (alertValue) {
                alertPeak = (alertValue * 1.2);
                highPeak = peak + ((peak - min) * 0.2);
                visuallyAdjustedMax = alertPeak > highPeak ? alertPeak : highPeak;
              } else {
                visuallyAdjustedMax = peak + ((peak - min) * 0.2);
              }

              return [visuallyAdjustedMin, !!!visuallyAdjustedMax && !!!visuallyAdjustedMin ? DEFAULT_Y_SCALE : visuallyAdjustedMax];
            }


            function determineMultiScale(multiDataPoints:IMultiDataPoint[]) {
              const xTicks = 9;

              if (multiDataPoints && multiDataPoints[0] && multiDataPoints[0].values) {

                let lowHigh = setupFilteredMultiData(multiDataPoints);
                visuallyAdjustedMin = lowHigh[0];
                visuallyAdjustedMax = lowHigh[1];

                yScale = d3.scale.linear()
                  .clamp(true)
                  .rangeRound([height, 0])
                  .domain([visuallyAdjustedMin, visuallyAdjustedMax]);

                yAxis = d3.svg.axis()
                  .scale(yScale)
                  .ticks(5)
                  .tickSize(4, 4, 0)
                  .orient('left');

                timeScale = d3.time.scale()
                  .range([0, width])
                  .domain([d3.min(multiDataPoints, (d) => d3.min(d.values, (p) => p.timestamp)),
                    d3.max(multiDataPoints, (d) => d3.max(d.values, (p) => p.timestamp))]);

                xAxis = d3.svg.axis()
                  .scale(timeScale)
                  .ticks(xTicks)
                  .tickFormat(xAxisTimeFormats())
                  .tickSize(4, 4, 0)
                  .orient('bottom');

              }
            }


            /**
             * Load metrics data directly from a running Hawkular-Metrics server
             * @param url
             * @param metricId
             * @param startTimestamp
             * @param endTimestamp
             * @param buckets
             */
            function loadStandAloneMetricsForTimeRange(url:UrlType,
                                                       metricId:MetricId,
                                                       startTimestamp:TimeInMillis,
                                                       endTimestamp:TimeInMillis,
                                                       buckets = 60) {

              let requestConfig:ng.IRequestConfig = <any> {
                headers: {
                  'Hawkular-Tenant': metricTenantId
                },
                params: {
                  start: startTimestamp,
                  end: endTimestamp,
                  buckets: buckets
                }
              };

              if (startTimestamp >= endTimestamp) {
                $log.log('Start date was after end date');
              }


              if (url && metricType && metricId) {

                let metricTypeAndData = metricType.split('-');
                /// sample url:
                /// http://localhost:8080/hawkular/metrics/gauges/45b2256eff19cb982542b167b3957036.status.duration/data?
                // buckets=120&end=1436831797533&start=1436828197533'
                $http.get(url + '/' + metricTypeAndData[0] + 's/' + metricId + '/' + (metricTypeAndData[1] || 'data'),
                  requestConfig).success((response) => {

                  processedNewData = formatBucketedChartOutput(response);
                  scope.render(processedNewData, processedPreviousRangeData);

                }).error((reason, status) => {
                  $log.error('Error Loading Chart Data:' + status + ', ' + reason);
                });
              }

            }

            /**
             * Transform the raw http response from Metrics to one usable in charts
             * @param response
             * @returns transformed response to IChartDataPoint[], ready to be charted
             */
            function formatBucketedChartOutput(response):IChartDataPoint[] {
              //  The schema is different for bucketed output
              if (response) {
                return response.map((point:IChartDataPoint) => {
                  let timestamp:TimeInMillis = point.timestamp || (point.start + (point.end - point.start) / 2);
                  return {
                    timestamp: timestamp,
                    date: new Date(timestamp),
                    value: !angular.isNumber(point.value) ? undefined : point.value,
                    avg: (point.empty) ? undefined : point.avg,
                    min: !angular.isNumber(point.min) ? undefined : point.min,
                    max: !angular.isNumber(point.max) ? undefined : point.max,
                    empty: point.empty
                  };
                });
              }
            }


            function buildHover(d:IChartDataPoint, i:number) {
              let hover,
                prevTimestamp,
                currentTimestamp = d.timestamp,
                barDuration,
                formattedDateTime = moment(d.timestamp).format(HOVER_DATE_TIME_FORMAT);

              if (i > 0) {
                prevTimestamp = chartData[i - 1].timestamp;
                barDuration = moment(currentTimestamp).from(moment(prevTimestamp), true);
              }

              if (isEmptyDataPoint(d)) {
                // nodata
                hover = `<div class='chartHover'>
                <small class='chartHoverLabel'>${noDataLabel}</small>
                <div><small><span class='chartHoverLabel'>${durationLabel}</span><span>: </span><span class='chartHoverValue'>${barDuration}</span></small> </div>
                <hr/>
                <div><small><span class='chartHoverLabel'>${timestampLabel}</span><span>: </span><span class='chartHoverValue'>${formattedDateTime}</span></small></div>
                </div>`;
              } else {
                if (isRawMetric(d)) {
                  // raw single value from raw table
                  hover = `<div class='chartHover'>
                <div><small><span class='chartHoverLabel'>${timestampLabel}</span><span>: </span><span class='chartHoverValue'>${formattedDateTime}</span></small></div>
                  <div><small><span class='chartHoverLabel'>${durationLabel}</span><span>: </span><span class='chartHoverValue'>${barDuration}</span></small></div>
                  <hr/>
                  <div><small><span class='chartHoverLabel'>${singleValueLabel}</span><span>: </span><span class='chartHoverValue'>${d3.round(d.value, 2)}</span></small> </div>
                  </div> `;
                } else {
                  // aggregate with min/avg/max
                  hover = `<div class='chartHover'>
                    <div class="info-item">
                      <span class='chartHoverLabel'>${timestampLabel}:</span>
                      <span class='chartHoverValue'>${formattedDateTime}</span>
                    </div>
                    <div class="info-item before-separator">
                      <span class='chartHoverLabel'>${durationLabel}:</span>
                      <span class='chartHoverValue'>${barDuration}</span>
                    </div>
                    <div class="info-item separator">
                      <span class='chartHoverLabel'>${maxLabel}:</span>
                      <span class='chartHoverValue'>${d3.round(d.max, 2)}</span>
                    </div>
                    <div class="info-item">
                      <span class='chartHoverLabel'>${avgLabel}:</span>
                      <span class='chartHoverValue'>${d3.round(d.avg, 2)}</span>
                    </div>
                    <div class="info-item">
                      <span class='chartHoverLabel'>${minLabel}:</span>
                      <span class='chartHoverValue'>${d3.round(d.min, 2)}</span>
                    </div>
                  </div> `;
                }
              }
              return hover;

            }


            function createMultiLineChart(multiDataPoints:IMultiDataPoint[]) {
              let colorScale = d3.scale.category10(),
                g = 0;

              if (multiDataPoints) {
                // before updating, let's remove those missing from datapoints (if any)
                svg.selectAll('path[id^=\'multiLine\']')[0].forEach((existingPath:any) => {
                  let stillExists = false;
                  multiDataPoints.forEach((singleChartData:any) => {
                    singleChartData.keyHash = singleChartData.keyHash || ('multiLine' + hashString(singleChartData.key));
                    if (existingPath.getAttribute('id') === singleChartData.keyHash) {
                      stillExists = true;
                    }
                  });
                  if (!stillExists) {
                    existingPath.remove();
                  }
                });

                multiDataPoints.forEach((singleChartData:any) => {
                  if (singleChartData && singleChartData.values) {
                    singleChartData.keyHash = singleChartData.keyHash || ('multiLine' + hashString(singleChartData.key));
                    let pathMultiLine = svg.selectAll('path#' + singleChartData.keyHash).data([singleChartData.values]);
                    // update existing
                    pathMultiLine.attr('id', singleChartData.keyHash)
                      .attr('class', 'multiLine')
                      .attr('fill', 'none')
                      .attr('stroke', () => {
                        return singleChartData.color || colorScale(g++);
                      })
                      .transition()
                      .attr('d', createLine('linear'));
                    // add new ones
                    pathMultiLine.enter().append('path')
                      .attr('id', singleChartData.keyHash)
                      .attr('class', 'multiLine')
                      .attr('fill', 'none')
                      .attr('stroke', () => {
                        if (singleChartData.color) {
                          return singleChartData.color;
                        } else {
                          return colorScale(g++);
                        }
                      })
                      .transition()
                      .attr('d', createLine('linear'));
                    // remove old ones
                    pathMultiLine.exit().remove();
                  }
                });
              } else {
                $log.warn('No multi-data set for multiline chart');
              }

            }


            function createYAxisGridLines() {
              // create the y axis grid lines
              if (yScale) {
                let yAxis = svg.selectAll('g.grid.y_grid');
                if (!yAxis[0].length) {
                  yAxis = svg.append('g').classed('grid y_grid', true);
                }
                yAxis
                  .call(d3.svg.axis()
                    .scale(yScale)
                    .orient('left')
                    .ticks(10)
                    .tickSize(-width, 0)
                    .tickFormat('')
                  );
              }
            }

            function createXandYAxes() {

              function axisTransition(selection) {
                selection
                  .transition()
                  .delay(250)
                  .duration(750)
                  .attr("opacity", 1.0);
              }

              if (yAxis) {

                svg.selectAll('g.axis').remove();

                // create x-axis
                let xAxisGroup = svg.append('g')
                  .attr('class', 'x axis')
                  .attr('transform', 'translate(0,' + height + ')')
                  .attr("opacity", 0.3)
                  .call(xAxis)
                  .call(axisTransition);

                // create y-axis
                let yAxisGroup = svg.append('g')
                  .attr('class', 'y axis')
                  .attr("opacity", 0.3)
                  .call(yAxis)
                  .call(axisTransition);

                let yAxisLabel = svg.selectAll('.yAxisUnitsLabel');
                if (yAxisLabel.empty()) {
                  yAxisLabel = svg.append('text').attr('class', 'yAxisUnitsLabel')
                    .attr('transform', 'rotate(-90),translate(-10,-50)')
                    .attr('x', -CHART_HEIGHT / 2)
                    .style('text-anchor', 'start')
                    .text(attrs.yAxisUnits === 'NONE' ? '' : attrs.yAxisUnits)
                    .attr("opacity", 0.3)
                    .call(axisTransition);
                }
              }

            }

            function createCenteredLine(newInterpolation) {
              let interpolate = newInterpolation || 'monotone',
                line = d3.svg.line()
                  .interpolate(interpolate)
                  .defined((d) => {
                    return !isEmptyDataPoint(d);
                  })
                  .x((d) => {
                    return timeScale(d.timestamp);
                  })
                  .y((d)=> {
                    return isRawMetric(d) ? yScale(d.value) : yScale(d.avg);
                  });

              return line;
            }

            function createLine(newInterpolation) {
              let interpolate = newInterpolation || 'monotone',
                line = d3.svg.line()
                  .interpolate(interpolate)
                  .defined((d) => {
                    return !isEmptyDataPoint(d);
                  })
                  .x((d) => {
                    return timeScale(d.timestamp);
                  })
                  .y((d)=> {
                    return isRawMetric(d) ? yScale(d.value) : yScale(d.avg);
                  });

              return line;
            }


            function createAvgLines() {
              if (chartType === 'bar' || chartType === 'scatterline') {
                let pathAvgLine = svg.selectAll('.barAvgLine').data([chartData]);
                // update existing
                pathAvgLine.attr('class', 'barAvgLine')
                  .attr('d', createCenteredLine('monotone'));
                // add new ones
                pathAvgLine.enter().append('path')
                  .attr('class', 'barAvgLine')
                  .attr('d', createCenteredLine('monotone'));
                // remove old ones
                pathAvgLine.exit().remove();
              }
            }

            function createXAxisBrush() {

              brushGroup = svg.selectAll('g.brush');
              if (brushGroup.empty()) {
                brushGroup = svg.append('g').attr('class', 'brush');
              }

              brush = d3.svg.brush()
                .x(timeScale)
                .on('brushstart', brushStart)
                .on('brushend', brushEnd);

              brushGroup.call(brush);

              brushGroup.selectAll('.resize').append('path');

              brushGroup.selectAll('rect')
                .attr('height', height);

              function brushStart() {
                svg.classed('selecting', true);
              }

              function brushEnd() {
                let extent = brush.extent(),
                  startTime = Math.round(extent[0].getTime()),
                  endTime = Math.round(extent[1].getTime()),
                  dragSelectionDelta = endTime - startTime;

                svg.classed('selecting', !d3.event.target.empty());
                // ignore range selections less than 1 minute
                if (dragSelectionDelta >= 60000) {
                  forecastDataPoints = [];
                  showForecastData(forecastDataPoints);
                  $rootScope.$broadcast(EventNames.CHART_TIMERANGE_CHANGED.toString(), extent);
                }
                // clear the brush selection
                brushGroup.call(brush.clear());
              }

            }

            function createPreviousRangeOverlay(prevRangeData) {
              if (prevRangeData) {
                svg.append('path')
                  .datum(prevRangeData)
                  .attr('class', 'prevRangeAvgLine')
                  .style('stroke-dasharray', ('9,3'))
                  .attr('d', createCenteredLine('linear'));
              }

            }

            function annotateChart(annotationData) {
              if (annotationData) {
                svg.selectAll('.annotationDot')
                  .data(annotationData)
                  .enter().append('circle')
                  .attr('class', 'annotationDot')
                  .attr('r', 5)
                  .attr('cx', (d) => {
                    return timeScale(d.timestamp);
                  })
                  .attr('cy', () => {
                    return height - yScale(visuallyAdjustedMax);
                  })
                  .style('fill', (d) => {
                    if (d.severity === '1') {
                      return 'red';
                    } else if (d.severity === '2') {
                      return 'yellow';
                    } else {
                      return 'white';
                    }
                  });
              }
            }


            function createForecastLine(newInterpolation) {
              let interpolate = newInterpolation || 'monotone',
                line = d3.svg.line()
                  .interpolate(interpolate)
                  .x((d) => {
                    return timeScale(d.timestamp);
                  })
                  .y((d)=> {
                    return yScale(d.value);
                  });

              return line;
            }


            function showForecastData(forecastData:ISimpleMetric[]) {
              let forecastPathLine = svg.selectAll('.forecastLine').data([forecastData]);
              // update existing
              forecastPathLine.attr('class', 'forecastLine')
                .attr('d', createForecastLine('monotone'));
              // add new ones
              forecastPathLine.enter().append('path')
                .attr('class', 'forecastLine')
                .attr('d', createForecastLine('monotone'));
              // remove old ones
              forecastPathLine.exit().remove();

            }

            scope.$watchCollection('data', (newData) => {
              if (newData) {
                processedNewData = angular.fromJson(newData);
                scope.render(processedNewData, processedPreviousRangeData);
              }
            });

            scope.$watch('multiData', (newMultiData) => {
              if (newMultiData) {
                multiDataPoints = angular.fromJson(newMultiData);
                scope.render(processedNewData, processedPreviousRangeData);
              }
            }, true);


            scope.$watch('previousRangeData', (newPreviousRangeValues) => {
              if (newPreviousRangeValues) {
                //$log.debug('Previous Range data changed');
                processedPreviousRangeData = angular.fromJson(newPreviousRangeValues);
                scope.render(processedNewData, processedPreviousRangeData);
              }
            }, true);

            scope.$watch('annotationData', (newAnnotationData) => {
              if (newAnnotationData) {
                annotationData = angular.fromJson(newAnnotationData);
                scope.render(processedNewData, processedPreviousRangeData);
              }
            }, true);

            scope.$watch('forecastData', (newForecastData) => {
              if (newForecastData) {
                forecastDataPoints = angular.fromJson(newForecastData);
                scope.render(processedNewData, processedPreviousRangeData);
              }
            }, true);

            scope.$watchGroup(['alertValue', 'chartType', 'hideHighLowValues', 'useZeroMinValue', 'showAvgLine'],
              (chartAttrs) => {
                alertValue = chartAttrs[0] || alertValue;
                chartType = chartAttrs[1] || chartType;
                hideHighLowValues = (typeof chartAttrs[2] !== 'undefined') ? chartAttrs[2] : hideHighLowValues;
                useZeroMinValue = (typeof chartAttrs[3] !== 'undefined') ? chartAttrs[3] : useZeroMinValue;
                showAvgLine = (typeof chartAttrs[4] !== 'undefined') ? chartAttrs[4] : showAvgLine;
                scope.render(processedNewData, processedPreviousRangeData);
              });


            function loadStandAloneMetricsTimeRangeFromNow() {
              endTimestamp = Date.now();
              startTimestamp = moment().subtract(timeRangeInSeconds, 'seconds').valueOf();
              loadStandAloneMetricsForTimeRange(dataUrl, metricId, startTimestamp, endTimestamp, 60);
            }

            /// standalone charts attributes
            scope.$watchGroup(['metricUrl', 'metricId', 'metricType', 'metricTenantId', 'timeRangeInSeconds'],
              (standAloneParams) => {
                dataUrl = standAloneParams[0] || dataUrl;
                metricId = standAloneParams[1] || metricId;
                metricType = standAloneParams[2] || metricId;
                metricTenantId = standAloneParams[3] || metricTenantId;
                timeRangeInSeconds = standAloneParams[4] || timeRangeInSeconds;
                loadStandAloneMetricsTimeRangeFromNow();
              });

            scope.$watch('refreshIntervalInSeconds', (newRefreshInterval) => {
              if (newRefreshInterval) {
                refreshIntervalInSeconds = +newRefreshInterval;
                $interval.cancel(startIntervalPromise);
                startIntervalPromise = $interval(() => {
                  loadStandAloneMetricsTimeRangeFromNow();
                }, refreshIntervalInSeconds * 1000);
              }
            });

            scope.$on('$destroy', () => {
              $interval.cancel(startIntervalPromise);
            });

            scope.$on('DateRangeDragChanged', (event, extent) => {
              scope.$emit('GraphTimeRangeChangedEvent', extent);
            });


            function determineChartType(chartType:string) {

              switch (chartType) {
                case 'rhqbar' :
                  createHistogramChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    true,
                    visuallyAdjustedMax,
                    hideHighLowValues);
                  break;
                case 'histogram' :
                  createHistogramChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    false,
                    visuallyAdjustedMax,
                    hideHighLowValues);
                  break;
                case 'line' :
                  createLineChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    interpolation);
                  break;
                case 'hawkularmetric' :
                  $log.info('DEPRECATION WARNING: The chart type hawkularmetric has been deprecated and will be' +
                    ' removed in a future' +
                    ' release. Please use the line chart type in its place');
                  createLineChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    interpolation);
                  break;
                case 'multiline' :
                  createMultiLineChart(multiDataPoints);
                  break;
                case 'area' :
                  createAreaChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    interpolation,
                    hideHighLowValues);
                  break;
                case 'scatter' :
                  createScatterChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    interpolation,
                    hideHighLowValues);
                  break;
                case 'scatterline' :
                  createScatterLineChart(svg,
                    timeScale,
                    yScale,
                    chartData,
                    height,
                    interpolation,
                    hideHighLowValues);
                  break;
                default:
                  $log.warn('chart-type is not valid. Must be in' +
                    ' [rhqbar,line,area,multiline,scatter,scatterline,histogram] chart type: ' + chartType);

              }
            }


            scope.render = (dataPoints, previousRangeDataPoints) => {
              // if we don't have data, don't bother..
              if (!dataPoints && !multiDataPoints) {
                return;
              }

              debug && console.group('Render Chart');
              debug && console.time('chartRender');
              //NOTE: layering order is important!
              if (!hasInit) {
                initialization();
              }
              if (dataPoints) {
                determineScale(dataPoints);
              }

              if (multiDataPoints) {
                determineMultiScale(multiDataPoints);
              }

              if (alertValue && (alertValue > visuallyAdjustedMin && alertValue < visuallyAdjustedMax)) {
                const alertBounds:AlertBound[] = extractAlertRanges(chartData, alertValue);
                createAlertBoundsArea(svg, timeScale, yScale, visuallyAdjustedMax, alertBounds);
              }
              createXAxisBrush();

              createYAxisGridLines();
              determineChartType(chartType);
              if (showDataPoints) {
                createDataPoints(svg, timeScale, yScale, tip, chartData);
              }
              createPreviousRangeOverlay(previousRangeDataPoints);
              createXandYAxes();
              if (showAvgLine) {
                createAvgLines();
              }

              if (alertValue && (alertValue > visuallyAdjustedMin && alertValue < visuallyAdjustedMax)) {
                /// NOTE: this alert line has higher precedence from alert area above
                createAlertLine(svg, timeScale, yScale, chartData, alertValue, 'alertLine');
              }

              if (annotationData) {
                annotateChart(annotationData);
              }
              if (forecastDataPoints && forecastDataPoints.length > 0) {
                showForecastData(forecastDataPoints);
              }
              debug && console.timeEnd('chartRender');
              debug && console.groupEnd('Render Chart');
            };
          }

          return {
            link: link,
            restrict: 'E',
            replace: true,
            scope: {
              data: '=',
              multiData: '=',
              forecastData: '=',
              metricUrl: '@',
              metricId: '@',
              metricType: '@',
              metricTenantId: '@',
              startTimestamp: '@',
              endTimestamp: '@',
              timeRangeInSeconds: '@',
              refreshIntervalInSeconds: '@',
              previousRangeData: '@',
              annotationData: '@',
              showDataPoints: '=',
              alertValue: '@',
              interpolation: '@',
              chartType: '@',
              yAxisUnits: '@',
              useZeroMinValue: '=',
              chartHoverDateFormat: '@',
              chartHoverTimeFormat: '@',
              singleValueLabel: '@',
              noDataLabel: '@',
              durationLabel: '@',
              minLabel: '@',
              maxLabel: '@',
              avgLabel: '@',
              timestampLabel: '@',
              showAvgLine: '=',
              hideHighLowValues: '='
            }
          };
        }

      ]
    )
  ;
}
