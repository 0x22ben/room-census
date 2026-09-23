// Line charts drawn by Chart.js from the data-chart attribute of each canvas. Colors come from the
// design tokens, so a theme change redraws the chart. Points can be selected with a pointer, by
// touch or with the arrow keys. The same numbers are always available as a table next to the chart.
import { CategoryScale, Chart, LinearScale, LineController, LineElement, PointElement, Tooltip } from "chart.js";
import { rate } from "../lib/format";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip);

type Series = { label: string; token: string; values: (number | null)[] };
type Spec = { labels: string[]; series: Series[]; unit: string; min?: number };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function options(spec: Spec) {
  const muted = css("--color-text-muted");
  const grid = css("--color-border");
  const format = (v: number) => `${rate(v)}${spec.unit}`;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reduced.matches ? false : ({ duration: 200 } as const),
    interaction: { mode: "index" as const, intersect: false },
    layout: { padding: { top: 8, right: 8 } },
    scales: {
      x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, font: { family: css("--font-mono"), size: 12 } } },
      y: { min: spec.min, grid: { color: grid }, border: { display: false },
        ticks: { color: muted, font: { family: css("--font-mono"), size: 12 }, callback: (v: string | number) => format(Number(v)) } },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--color-surface-raised"), borderColor: css("--color-border-strong"), borderWidth: 1,
        titleColor: css("--color-text"), bodyColor: css("--color-text-secondary"), padding: 10,
        titleFont: { family: css("--font-sans"), weight: "bold" as const }, bodyFont: { family: css("--font-sans") },
        callbacks: { label: (c: { dataset: { label?: string }; parsed: { y: number | null } }) =>
          `${c.dataset.label}: ${c.parsed.y === null ? "no value" : format(c.parsed.y)}` },
      },
    },
  };
}

function datasets(spec: Spec) {
  return spec.series.map((s) => {
    const color = css(s.token);
    return { label: s.label, data: s.values, borderColor: color, backgroundColor: css("--color-surface"),
      pointBorderColor: color, pointBackgroundColor: css("--color-surface"), pointRadius: 4, pointHoverRadius: 6,
      borderWidth: 2.5, tension: 0.35, spanGaps: false };
  });
}

for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-chart]")) {
  const spec = JSON.parse(canvas.dataset.chart ?? "{}") as Spec;
  const chart = new Chart(canvas, { type: "line", data: { labels: spec.labels, datasets: datasets(spec) }, options: options(spec) });

  // keyboard: left and right arrows move along the censuses, Escape clears the selection
  let index = -1;
  canvas.addEventListener("keydown", (e) => {
    const last = spec.labels.length - 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      index = e.key === "ArrowRight" ? Math.min(last, index + 1) : Math.max(0, index < 0 ? last : index - 1);
      const active = spec.series.map((_, d) => ({ datasetIndex: d, index }));
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

  // follow the reader's theme
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    chart.data.datasets = datasets(spec);
    chart.options = options(spec);
    chart.update();
  });
}
