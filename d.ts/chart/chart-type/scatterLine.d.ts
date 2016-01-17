/// <reference path="../../../typings/tsd.d.ts" />
declare namespace Charts {
    import IChartDataPoint = Charts.IChartDataPoint;
    function createScatterLineChart(svg: any, timeScale: any, yScale: any, chartData: IChartDataPoint[], height?: number, interpolation?: string, hideHighLowValues?: boolean): void;
}
