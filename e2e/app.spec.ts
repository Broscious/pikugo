import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { inspectAnimation, readChunks } from "../src/core/webp";
import { readZip } from "../src/core/zip";

/** Collect uncaught errors and console errors so every test can assert a clean run. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}

async function loadSamples(page: Page) {
  await page.goto("./");
  await page.getByRole("button", { name: "Try sample photos" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#filmstrip .film-thumb")).toHaveCount(3);
}

/** Generate the animation and return the encoded bytes. */
async function generate(page: Page): Promise<Uint8Array> {
  const previous = await page.locator("#resultImage").getAttribute("src");
  await page.locator("#generateBtn").click();
  await expect(page.locator("#result")).toBeVisible();
  // Wait for the new result rather than reading the previous one.
  await expect(page.locator("#resultImage")).not.toHaveAttribute("src", previous ?? "");
  await expect(page.locator("#resultImage")).toHaveJSProperty("complete", true);
  const bytes = await page.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>("#resultImage")!;
    const buffer = await (await fetch(image.src)).arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  });
  return Uint8Array.from(bytes);
}

/** Click "Export stills", check the confirmation and return the downloaded file. */
async function exportStills(page: Page, message = "Exported") {
  const pending = page.waitForEvent("download");
  await page.locator("#stillsBtn").click();
  const download = await pending;
  await expect(page.locator(".toast").filter({ hasText: message })).toBeVisible();
  return { filename: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function resultSize(page: Page) {
  return page.locator("#resultImage").evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
}

test.beforeEach(async ({ page }) => {
  // Start every test from default settings.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("e2e-initialised")) {
      localStorage.clear();
      sessionStorage.setItem("e2e-initialised", "1");
    }
  });
});

test("landing page renders the header and hero", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("./");
  await expect(page).toHaveTitle(/Pikugo/);
  await expect(page.locator(".brand-name")).toHaveText("Pikugo");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("smooth wiggle");
  await expect(page.locator("#workspace")).toBeHidden();
  // Icons are drawn from inlined data URIs.
  const mask = await page.locator(".hero-actions .icon").first().evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
  expect(mask).toContain("data:image/svg+xml");
  expect(errors).toEqual([]);
});

test("sample photos produce a valid animated WebP in a worker", async ({ page }) => {
  const errors = trackErrors(page);
  await loadSamples(page);
  const bytes = await generate(page);
  const info = inspectAnimation(bytes);
  // Default playback is sway: 0 1 2 2 1 0.
  expect(info.frames).toHaveLength(6);
  expect(info.frames.every((frame) => frame.duration === 100)).toBe(true);
  expect(info.loopCount).toBe(0);
  // The browser can decode what we produced.
  expect(await resultSize(page)).toEqual({ width: info.width, height: info.height });
  await expect(page.locator("#resultStats")).toContainText("Web Worker");
  await expect(page.locator("#downloadBtn")).toHaveAttribute("download", /^pikugo-\d{8}-\d{6}\.webp$/);
  expect(errors).toEqual([]);
});

test("the frame order shows how each playback mode plays", async ({ page }) => {
  await loadSamples(page);
  const order = page.locator("#playbackOrder");
  // Sway is the default and holds each end frame.
  await expect(order).toHaveAttribute("aria-label", "Frame order: 1, 2, 3, 3, 2, 1");
  await expect(order.locator('[data-hold="start"]')).toHaveText(["3"]);
  // The pause on photo 1 spans the end of one loop and the start of the next.
  await expect(order.locator('[data-hold="wrap"]')).toHaveText(["1", "1"]);
  // Hovering another mode shows its order without selecting it.
  await page.getByRole("radio", { name: "Bounce", exact: true }).hover();
  await expect(order).toHaveAttribute("aria-label", "Frame order: 1, 2, 3, 2");
  await expect(page.locator("#playbackHint")).toContainText("turning straight round");
  // While the pointer is over the field, the order plays through, one frame every 500 ms whatever the frame delay.
  await expect(order.locator(".frame-tick").nth(1)).toHaveClass(/is-playing/, { timeout: 1500 });
  await expect(order.locator(".is-playing")).toHaveCount(1);
  // Away from it, the order goes back to the selected mode and stops animating.
  await page.mouse.move(0, 0);
  await expect(order).toHaveAttribute("aria-label", "Frame order: 1, 2, 3, 3, 2, 1");
  await expect(order.locator(".is-playing")).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(order.locator(".is-playing")).toHaveCount(0);
});

test("frame delay and bounce playback are written to the file", async ({ page }) => {
  await loadSamples(page);
  await page.locator("#delayInput").fill("250");
  await page.locator("#delayInput").press("Enter");
  await page.getByRole("radio", { name: "Bounce", exact: true }).click();
  await expect(page.locator("#delayHint")).toContainText("4.0 fps");
  const info = inspectAnimation(await generate(page));
  expect(info.frames).toHaveLength(4);
  expect(info.frames.map((frame) => frame.duration)).toEqual([250, 250, 250, 250]);

  await page.getByRole("radio", { name: "Loop" }).click();
  expect(inspectAnimation(await generate(page)).frames).toHaveLength(3);
});

test("aspect ratio crops to the requested shape", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("radio", { name: "1:1" }).click();
  const info = inspectAnimation(await generate(page));
  expect(Math.abs(info.width - info.height)).toBeLessThanOrEqual(1);

  await page.locator("#aspectCustom").fill("2:1");
  const wide = inspectAnimation(await generate(page));
  expect(wide.width / wide.height).toBeCloseTo(2, 1);
});

test("layer mode keeps every pixel and writes transparency", async ({ page }) => {
  await loadSamples(page);
  const cropped = inspectAnimation(await generate(page));
  await page.getByRole("radio", { name: /Layer with transparency/ }).click();
  await expect(page.locator("#staleBadge")).toBeVisible();
  const layered = inspectAnimation(await generate(page));
  expect(layered.width).toBeGreaterThan(cropped.width);
  expect(layered.height).toBeGreaterThan(cropped.height);
  expect(layered.hasAlpha).toBe(true);
  expect(layered.frames.some((frame) => frame.chunkTypes.includes("ALPH") || frame.chunkTypes.includes("VP8L"))).toBe(true);
  await expect(page.locator("#staleBadge")).toBeHidden();
});

test("fixed focus position changes the framing", async ({ page }) => {
  await loadSamples(page);
  const auto = inspectAnimation(await generate(page));
  await page.getByRole("radio", { name: "Fixed" }).click();
  // Grid corners snap to where the rule-of-thirds lines cross.
  await page.getByRole("button", { name: "Top left intersection" }).click();
  await expect(page.locator("#anchorXOut")).toHaveText("33%");
  await expect(page.locator("#anchorYOut")).toHaveText("33%");
  await expect(page.getByRole("button", { name: "Top left intersection" })).toHaveAttribute("aria-pressed", "true");
  const info = inspectAnimation(await generate(page));
  // Pinning the subject off-centre leaves less usable space than the automatic framing.
  expect(info.width).toBeLessThan(auto.width);
  expect(info.height).toBeLessThan(auto.height);

  // Edge buttons snap to the middle of a single guide line.
  await page.getByRole("button", { name: "Right line" }).click();
  await expect(page.locator("#anchorXOut")).toHaveText("67%");
  await expect(page.locator("#anchorYOut")).toHaveText("50%");
});

test("dragging the preview frame pins the focus position", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("button", { name: "Pause preview" }).click();
  const canvas = page.locator("#previewCanvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 40, centre.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("radio", { name: "Fixed" })).toHaveAttribute("aria-checked", "true");
});

/** Walk the pointer from `from` in steps of `step` until the preview shows `cursor`, and return that point. */
async function findCursor(page: Page, from: { x: number; y: number }, step: { x: number; y: number }, cursor: string) {
  for (let i = 0; i < 400; i += 1) {
    const point = { x: from.x + step.x * i, y: from.y + step.y * i };
    await page.mouse.move(point.x, point.y);
    if ((await page.locator("#previewStage").getAttribute("data-cursor")) === cursor) {
      return point;
    }
  }
  throw new Error(`No ${cursor} cursor found`);
}

/** Scroll the preview into view and return its centre. */
async function previewCentre(page: Page) {
  const canvas = page.locator("#previewCanvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  await page.mouse.up();
}

test("the preview frame can be resized by its edges and moved without touching an edge", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("button", { name: "Pause preview" }).click();
  const full = inspectAnimation(await generate(page));
  let centre = await previewCentre(page);

  // Free aspect ratio: dragging the right edge in narrows the frame and leaves its height alone.
  const right = await findCursor(page, centre, { x: 2, y: 0 }, "ew-resize");
  await drag(page, right, { x: -60, y: 0 });
  await expect(page.getByRole("radio", { name: "Fixed" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#fillFrameBtn")).toBeVisible();
  const narrowed = inspectAnimation(await generate(page));
  expect(narrowed.width).toBeLessThan(full.width - 20);
  expect(narrowed.height).toBe(full.height);

  // Moving a resized frame keeps its size, rather than growing back to touch an edge.
  centre = await previewCentre(page);
  await drag(page, centre, { x: -20, y: 0 });
  const moved = inspectAnimation(await generate(page));
  expect(moved).toMatchObject({ width: narrowed.width, height: narrowed.height });

  // Dragging a corner moves both of its sides.
  centre = await previewCentre(page);
  const rightEdge = await findCursor(page, centre, { x: 2, y: 0 }, "ew-resize");
  const corner = await findCursor(page, rightEdge, { x: 0, y: 2 }, "nwse-resize");
  await drag(page, corner, { x: -30, y: -30 });
  const cornered = inspectAnimation(await generate(page));
  expect(cornered.width).toBeLessThan(narrowed.width);
  expect(cornered.height).toBeLessThan(narrowed.height);

  // A fixed aspect ratio is kept while resizing: the matching edge follows.
  await page.getByRole("radio", { name: "1:1" }).click();
  const square = inspectAnimation(await generate(page));
  expect(Math.abs(square.width - square.height)).toBeLessThanOrEqual(1);
  centre = await previewCentre(page);
  const edge = await findCursor(page, centre, { x: 0, y: -2 }, "ns-resize");
  await drag(page, edge, { x: 0, y: 20 });
  const smaller = inspectAnimation(await generate(page));
  expect(Math.abs(smaller.width - smaller.height)).toBeLessThanOrEqual(1);
  expect(smaller.width).toBeLessThan(square.width);

  // "Fill available space" goes back to the largest frame.
  await page.getByRole("radio", { name: "Free" }).click();
  await page.locator("#fillFrameBtn").click();
  await expect(page.locator("#fillFrameBtn")).toBeHidden();
  const filled = inspectAnimation(await generate(page));
  // The largest frame for where the subject now sits: at least as big as before, and bigger overall.
  expect(filled.width).toBeGreaterThanOrEqual(smaller.width);
  expect(filled.height).toBeGreaterThanOrEqual(smaller.height);
  expect(filled.width * filled.height).toBeGreaterThan(smaller.width * smaller.height);
});

test("hovering an option previews it without applying it", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("radio", { name: /Layer with transparency/ }).hover();
  await expect(page.locator("#previewBadge")).toHaveText("Previewing: Layer with transparency");
  await page.locator(".brand").hover();
  await expect(page.locator("#previewBadge")).toBeHidden();
  await expect(page.getByRole("radio", { name: /Crop to overlap/ })).toHaveAttribute("aria-checked", "true");
});

test("uploaded photos can be focused, reordered and removed", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("./");
  const pngs = await page.evaluate(async () => {
    const make = async (hue: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext("2d")!;
      context.fillStyle = `hsl(${hue} 70% 60%)`;
      context.fillRect(0, 0, 320, 240);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    };
    return Promise.all([0, 120, 240].map(make));
  });
  await page.locator("#fileInput").setInputFiles(
    pngs.map((bytes, index) => ({ name: `photo-${index + 1}.png`, mimeType: "image/png", buffer: Buffer.from(bytes) })),
  );
  await expect(page.locator("#filmstrip .film-thumb")).toHaveCount(3);
  await expect(page.locator('[data-step="focus"] .step-detail')).toHaveText("0/3");

  // Click the top-left quarter of the first photo.
  await page.locator("#magnifyToggle").click();
  const image = page.locator("#selectedImage");
  const box = (await image.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await expect(page.locator('[data-step="focus"] .step-detail')).toHaveText("1/3");
  // Flat colours have nothing to match, so auto-match says so and leaves the others alone.
  await expect(page.locator(".toast").last()).toContainText("isn't enough detail");
  const marker = await page.locator("#selectionMarker").evaluate((el) => [el.style.left, el.style.top]);
  expect(parseFloat(marker[0]!)).toBeCloseTo(25, 0);
  expect(parseFloat(marker[1]!)).toBeCloseTo(25, 0);

  // Keyboard: next photo, nudge its focus.
  await page.locator("#viewerContainer").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#imageCounter")).toHaveText("2 / 3");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.locator('[data-step="focus"] .step-detail')).toHaveText("2/3");

  // Move the first frame later, then remove one.
  await page.locator(".film-item").first().hover();
  await page.getByRole("button", { name: "Move later" }).first().click();
  await expect(page.locator(".film-name").first()).toHaveText("photo-2.png");
  await page.locator(".film-item").first().hover();
  await page.getByRole("button", { name: "Remove photo-2.png" }).click();
  await expect(page.locator("#filmstrip .film-thumb")).toHaveCount(2);

  const info = inspectAnimation(await generate(page));
  expect(info.frames).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("a single photo produces a still WebP", async ({ page }) => {
  await loadSamples(page);
  for (let i = 0; i < 2; i += 1) {
    await page.locator(".film-item").first().hover();
    await page.locator(".film-action.is-remove").first().click();
  }
  await expect(page.locator("#filmstrip .film-thumb")).toHaveCount(1);
  const bytes = await generate(page);
  const types = readChunks(bytes).map((chunk) => chunk.type);
  expect(types).not.toContain("ANIM");
  expect(types.some((type) => type === "VP8 " || type === "VP8L" || type === "VP8X")).toBe(true);
});

test("options persist across reloads and the theme toggles", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Try sample photos" }).click();
  await page.getByRole("radio", { name: "16:9" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Try sample photos" }).click();
  await expect(page.getByRole("radio", { name: "16:9" })).toHaveAttribute("aria-checked", "true");

  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator("#themeToggle").click();
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after).not.toBe(before);
});

test("stills export as aligned PNGs in a zip, matching the animation", async ({ page }) => {
  const errors = trackErrors(page);
  await loadSamples(page);
  await page.getByRole("radio", { name: /Layer with transparency/ }).click();
  const animation = inspectAnimation(await generate(page));

  const { filename, bytes } = await exportStills(page, "Exported 3 PNG stills");
  expect(filename).toMatch(/^pikugo-stills-\d{8}-\d{6}\.zip$/);
  const entries = readZip(bytes);
  // One still per photo, in photo order, even though sway repeats frames.
  expect(entries.map((entry) => entry.name)).toEqual(["01-sample-1.png", "02-sample-2.png", "03-sample-3.png"]);
  for (const entry of entries) {
    expect(pngSize(entry.data)).toEqual({ width: animation.width, height: animation.height });
  }
  await expect(page.locator("#stillsBtn")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("a single photo exports as one PNG", async ({ page }) => {
  await loadSamples(page);
  for (let i = 0; i < 2; i += 1) {
    await page.locator(".film-item").first().hover();
    await page.locator(".film-action.is-remove").first().click();
  }
  await expect(page.locator("#stillsLabel")).toHaveText("Export still");
  const { filename, bytes } = await exportStills(page);
  expect(filename).toBe("01-sample-3.png");
  expect(pngSize(bytes).width).toBeGreaterThan(0);
});

test("stills can be exported as JPEG, flattened onto black where photos don't cover", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("radio", { name: /Layer with transparency/ }).click();
  await page.getByRole("radio", { name: "JPEG" }).click();
  await expect(page.locator("#stillFormatHint")).toContainText("become black");
  // Changing the stills format doesn't affect the animation, so the preview badge doesn't appear.
  await expect(page.locator("#previewBadge")).toBeHidden();

  const { bytes } = await exportStills(page, "Exported 3 JPEG stills");
  const entries = readZip(bytes);
  expect(entries.map((entry) => entry.name)).toEqual(["01-sample-1.jpg", "02-sample-2.jpg", "03-sample-3.jpg"]);

  // Decode each JPEG in the browser and look at its corners: in layer mode some are uncovered.
  const corners = await page.evaluate(async (files) => {
    const results: number[][] = [];
    for (const data of files) {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      for (const [x, y] of [[1, 1], [bitmap.width - 2, 1], [1, bitmap.height - 2], [bitmap.width - 2, bitmap.height - 2]]) {
        results.push([...context.getImageData(x!, y!, 1, 1).data]);
      }
    }
    return results;
  }, entries.map((entry) => Array.from(entry.data)));
  for (const entry of entries) {
    expect([...entry.data.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  }
  expect(corners.every((pixel) => pixel[3] === 255)).toBe(true);
  expect(corners.some((pixel) => pixel[0]! < 16 && pixel[1]! < 16 && pixel[2]! < 16)).toBe(true);
});

test("stills can be exported as WebP and the format persists", async ({ page }) => {
  await loadSamples(page);
  await page.getByRole("radio", { name: "WebP", exact: true }).click();
  const { bytes } = await exportStills(page);
  const entries = readZip(bytes);
  expect(entries.map((entry) => entry.name.split(".").pop())).toEqual(["webp", "webp", "webp"]);
  for (const entry of entries) {
    expect(readChunks(entry.data).length).toBeGreaterThan(0);
  }
  await page.reload();
  await page.getByRole("button", { name: "Try sample photos" }).click();
  await expect(page.getByRole("radio", { name: "WebP", exact: true })).toHaveAttribute("aria-checked", "true");
});

/**
 * Upload three "photos" cut from one cluttered scene at different offsets, as
 * if the camera moved between shots. Returns each photo's offset in the scene.
 */
async function uploadShiftedPhotos(page: Page) {
  const offsets = [
    { x: 40, y: 30 },
    { x: 66, y: 42 },
    { x: 18, y: 51 },
  ];
  const pngs = await page.evaluate(async (cuts) => {
    let seed = 7;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const world = document.createElement("canvas");
    world.width = 720;
    world.height = 560;
    const scene = world.getContext("2d")!;
    scene.fillStyle = "#6b8fb5";
    scene.fillRect(0, 0, 720, 560);
    for (let n = 0; n < 500; n += 1) {
      scene.fillStyle = `hsl(${Math.floor(next() * 360)} ${40 + next() * 50}% ${25 + next() * 55}%)`;
      scene.beginPath();
      scene.ellipse(next() * 720, next() * 560, 3 + next() * 26, 3 + next() * 26, next() * Math.PI, 0, Math.PI * 2);
      scene.fill();
    }
    return Promise.all(
      cuts.map(async (cut) => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        canvas.getContext("2d")!.drawImage(world, -cut.x, -cut.y);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }),
    );
  }, offsets);
  await page.locator("#fileInput").setInputFiles(
    pngs.map((bytes, index) => ({ name: `shot-${index + 1}.png`, mimeType: "image/png", buffer: Buffer.from(bytes) })),
  );
  await expect(page.locator("#filmstrip .film-thumb")).toHaveCount(3);
  await page.locator("#magnifyToggle").click();
  return offsets;
}

/** Click a point (in photo pixels) on the photo shown in the focus editor. */
async function clickPhoto(page: Page, point: { x: number; y: number }) {
  const image = page.locator("#selectedImage");
  await image.scrollIntoViewIfNeeded();
  const box = (await image.boundingBox())!;
  await page.mouse.click(box.x + (point.x / 640) * box.width, box.y + (point.y / 480) * box.height);
}

/** The shown photo's focus point, in photo pixels. */
async function shownFocus(page: Page) {
  const [left, top] = await page.locator("#selectionMarker").evaluate((el) => [el.style.left, el.style.top]);
  return { x: (parseFloat(left!) / 100) * 640, y: (parseFloat(top!) / 100) * 480 };
}

async function showPhoto(page: Page, index: number) {
  await page.locator(".film-thumb").nth(index).click();
  await expect(page.locator("#imageCounter")).toHaveText(`${index + 1} / 3`);
}

/** Where `point` in photo `from` appears in photo `to`. */
function moved(offsets: { x: number; y: number }[], point: { x: number; y: number }, from: number, to: number) {
  return { x: point.x + offsets[from]!.x - offsets[to]!.x, y: point.y + offsets[from]!.y - offsets[to]!.y };
}

/** Clicks land to within a pixel or so on screen; allow a little for that. */
function expectNear(found: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(Math.abs(found.x - expected.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(found.y - expected.y)).toBeLessThanOrEqual(3);
}

test("auto-match finds the same spot in the other photos", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("./");
  const offsets = await uploadShiftedPhotos(page);
  const clicked = { x: 330, y: 250 };
  await clickPhoto(page, clicked);

  // The other two photos are matched automatically, each against the photo before it.
  await expect(page.locator('[data-step="focus"] .step-detail')).toHaveText("3/3");
  await expect(page.locator('.film-item[data-auto="true"]')).toHaveCount(2);
  for (const index of [1, 2]) {
    await showPhoto(page, index);
    expectNear(await shownFocus(page), moved(offsets, clicked, 0, index));
    await expect(page.locator("#matchBadge")).toContainText(`Auto-matched to photo ${index}`);
    await expect(page.locator("#selectionMarker")).toHaveClass(/is-auto/);
  }

  // Adjusting an auto-matched point by hand keeps it from being overwritten later,
  // and the photos after it are re-matched from it.
  await showPhoto(page, 1);
  const adjusted = { x: 100, y: 100 };
  await clickPhoto(page, adjusted);
  await expect(page.locator("#matchBadge")).toBeHidden();
  await expect(page.locator(".film-item").nth(1)).toHaveAttribute("data-auto", "false");
  await expect(page.locator('.film-item[data-auto="true"]')).toHaveCount(1);
  const manual = await shownFocus(page);
  await showPhoto(page, 2);
  await expect(page.locator("#matchBadge")).toContainText("Auto-matched to photo 2");
  await expect.poll(async () => Math.abs((await shownFocus(page)).x - moved(offsets, manual, 1, 2).x)).toBeLessThanOrEqual(3);
  expectNear(await shownFocus(page), moved(offsets, manual, 1, 2));
  expect(errors).toEqual([]);
});

test("auto-match works backward from a later photo", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("./");
  const offsets = await uploadShiftedPhotos(page);
  await showPhoto(page, 2);
  const clicked = { x: 300, y: 220 };
  await clickPhoto(page, clicked);

  await expect(page.locator('.film-item[data-auto="true"]')).toHaveCount(2);
  for (const index of [1, 0]) {
    await showPhoto(page, index);
    expectNear(await shownFocus(page), moved(offsets, clicked, 2, index));
    await expect(page.locator("#matchBadge")).toContainText(`Auto-matched to photo ${index + 2}`);
  }
  expect(errors).toEqual([]);
});

test("auto-match can be turned off, and remembers the choice", async ({ page }) => {
  await page.goto("./");
  await uploadShiftedPhotos(page);
  await page.locator("#autoMatchToggle").click();
  await expect(page.locator("#autoMatchToggle")).toHaveAttribute("aria-pressed", "false");
  await clickPhoto(page, { x: 330, y: 250 });
  await expect(page.locator('[data-step="focus"] .step-detail')).toHaveText("1/3");
  // Give a match time to (not) happen.
  await page.waitForTimeout(800);
  await expect(page.locator('.film-item[data-auto="true"]')).toHaveCount(0);

  // Turning it back on matches the others to the point already placed.
  await page.locator("#autoMatchToggle").click();
  await expect(page.locator('.film-item[data-auto="true"]')).toHaveCount(2);

  await page.locator("#autoMatchToggle").click();
  await page.reload();
  await expect(page.locator("#autoMatchToggle")).toHaveAttribute("aria-pressed", "false");
});
