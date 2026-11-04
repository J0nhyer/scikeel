import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui/Toaster";
import { AnomalyMapView } from "./AnomalyMapView";

const CSV = [
  "lat,lon,anomaly",
  "-45,-90,-2.0",
  "-45,90,1.0",
  "45,-90,0.5",
  "45,90,2.5",
].join("\n");

describe("AnomalyMapView", () => {
  it("renders the map with grid dims, unit, a canvas, and graticule labels", () => {
    const { container } = render(<AnomalyMapView filename="temp.anom" text={CSV} />);
    expect(container.textContent).toContain("temp.anom");
    expect(container.textContent).toContain("2×2 grid");
    expect(container.textContent).toContain("anomaly");
    expect(container.querySelector("canvas")).not.toBeNull();
    // graticule labels use hemisphere suffixes
    expect(container.textContent).toMatch(/°[NSEW]|0°/);
  });

  it("shows a friendly error for a non-grid file", async () => {
    render(<><AnomalyMapView filename="bad.anom" text="hello\nworld" /><Toaster /></>);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not read this anomaly grid/);
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  });
});
