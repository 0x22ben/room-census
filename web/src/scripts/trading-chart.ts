// The contest chart, drawn by Chart.js from the data-trading-chart attribute: a tab per view, a time
// range, an area under the first line and the latest value tagged on the right. Colors come from the
// design tokens and follow the reader's theme. Points can be read with a pointer, by touch or with the
// arrow keys.
import { robustRange } from "../lib/robust-range.mjs";
import { CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip, type Plugin } from "chart.js";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler);

type Series = { label: string; token: string; values: (number | null)[]; dashed?: boolean };
type View = { id: string; label: string; unit?: string; min?: number; series: Series[] };
type Spec = { views: View[]; at: string[] };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const tick = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(11, 16)}`;
const fmt = (v: number, unit = "") => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)) + unit;

/** The latest value of the first line, in a filled tag on the right edge. */
const lastTag: Plugin<"line"> = {
  id: "lastTag",
  afterDatasetsDraw(chart) {
    const set = chart.data.datasets[0];
    const meta = chart.getDatasetMeta(0);
    const data = set?.data as (number | null)[] | undefined;
    if (!data || !meta.data.length) return;
    let i = data.length - 1;
    while (i >= 0 && data[i] === null) i--;
    if (i < 0) return;
    const point = meta.data[i];
    const { ctx, chartArea } = chart;
    const text = fmt(data[i] as number);
    ctx.save();
    ctx.font = `600 11px ${css("--font-mono")}`;
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = set.borderColor as string;
    ctx.beginPath();
    ctx.roundRect(chartArea.right + 4, point.y - 9, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = css("--color-on-accent");
    ctx.textBaseline = "middle";
    ctx.fillText(text, chartArea.right + 9, point.y);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = set.borderColor as string;
    ctx.fill();
    ctx.restore();
  },
};

function build(root: HTMLElement, spec: Spec) {
  const canvas = root.querySelector("canvas")!;
  const legend = root.querySelector<HTMLElement>("[data-legend]")!;
  let view = spec.views[0];
  let range = 0;

  const slice = <T,>(a: T[]) => (range > 0 ? a.slice(-range) : a);

  function datasets() {
    return view.series.map((s, k) => {
      const color = css(s.token);
      return {
        label: s.label, data: slice(s.values), borderColor: color, borderWidth: k === 0 ? 2 : 1.5,
        borderDash: s.dashed ? [4, 4] : undefined, pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: true,
        fill: k === 0 ? "origin" : false,
        backgroundColor: (c: { chart: Chart }) => {
          const area = c.chart.chartArea;
          if (!area) return "transparent";
          const g = c.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, `${color}33`);
          g.addColorStop(1, `${color}00`);
          return g;
        },
      };
    });
  }

  function options() {
    const muted = css("--color-text-muted");
    const grid = css("--color-border");
    const mono = { family: css("--font-mono"), size: 11 };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduced.matches ? false : ({ duration: 200 } as const),
      interaction: { mode: "index" as const, intersect: false },
      layout: { padding: { top: 8, right: 64 } },
      scales: {
        x: { grid: { display: false }, border: { color: grid },
          ticks: { color: muted, font: mono, maxRotation: 0, autoSkip: true, maxTicksLimit: canvas.clientWidth < 500 ? 3 : 5,
            callback(this: { getLabelForValue(v: number): string }, v: string | number) { return tick(this.getLabelForValue(Number(v))); } } },
        y: { ...(robustRange(view.series.map((s) => slice(s.values)), view.min) ?? { min: view.min }), position: "right" as const, grid: { color: grid }, border: { display: false },
          ticks: { color: muted, font: mono, maxTicksLimit: 5, callback: (v: string | number) => fmt(Number(v)) } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--color-surface-raised"), borderColor: css("--color-border-strong"), borderWidth: 1,
          titleColor: css("--color-text"), bodyColor: css("--color-text-secondary"), padding: 10,
          titleFont: { family: css("--font-mono") }, bodyFont: { family: css("--font-sans") },
          callbacks: {
            title: (items: { label: string }[]) => (items[0] ? `${tick(items[0].label)} UTC` : ""),
            label: (c: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              `${c.dataset.label}: ${c.parsed.y === null ? "no value" : fmt(c.parsed.y, view.unit)}`,
          },
        },
      },
    };
  }

  const chart = new Chart(canvas, { type: "line", data: { labels: slice(spec.at), datasets: datasets() }, options: options(), plugins: [lastTag] });

  function drawLegend() {
    legend.replaceChildren(...view.series.map((s) => {
      const item = document.createElement("span");
      item.className = "inline-flex items-center gap-1.5";
      const swatch = document.createElement("span");
      swatch.className = "inline-block h-0.5 w-3 rounded";
      swatch.style.background = css(s.token);
      item.append(swatch, document.createTextNode(s.label));
      return item;
    }));
  }

  function redraw() {
    canvas.setAttribute("aria-label", `${view.label} chart: ${view.series.map((s) => s.label).join(", ")}, at each referee update.`);
    chart.data.labels = slice(spec.at);
    chart.data.datasets = datasets();
    chart.options = options();
    chart.update();
    drawLegend();
  }

  function press(group: string, button: HTMLElement) {
    root.querySelectorAll<HTMLElement>(`[${group}]`).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  }
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => b.addEventListener("click", () => {
    view = spec.views.find((v) => v.id === b.dataset.view) ?? view;
    press("data-view", b);
    redraw();
  }));
  root.querySelectorAll<HTMLElement>("[data-range]").forEach((b) => b.addEventListener("click", () => {
    range = Number(b.dataset.range);
    press("data-range", b);
    redraw();
  }));

  // keyboard: left and right arrows move along the updates, Escape clears the selection
  let index = -1;
  canvas.addEventListener("keydown", (e) => {
    const last = (chart.data.labels?.length ?? 1) - 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      index = e.key === "ArrowRight" ? Math.min(last, index + 1) : Math.max(0, index < 0 ? last : index - 1);
      const active = view.series.map((_, d) => ({ datasetIndex: d, index }));
      chart.setActiveElements(active);
      chart.tooltip?.setActiveElements(active, { x: 0, y: 0 });
      chart.update();
      e.preventDefault();
    } else if (e.key === "Escape") {
      index = -1;
      chart.setActiveElements([]);
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
      chart.update();
    }
  });

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", redraw);
  drawLegend();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-trading-chart]")) {
  build(root, JSON.parse(root.dataset.tradingChart ?? "{}") as Spec);
}
