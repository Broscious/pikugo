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

/** Click "Export stills" and return the downloaded file. */
async function exportStills(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator("#stillsBtn").click();
  const download = await pending;
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
  // Default playback is smooth bounce: 0 1 2 2 1 0.
  expect(info.frames).toHaveLength(6);
  expect(info.frames.every((frame) => frame.duration === 100)).toBe(true);
  expect(info.loopCount).toBe(0);
  // The browser can decode what we produced.
  expect(await resultSize(page)).toEqual({ width: info.width, height: info.height });
  await expect(page.locator("#resultStats")).toContainText("Web Worker");
  await expect(page.locator("#downloadBtn")).toHaveAttribute("download", /^pikugo-\d{8}-\d{6}\.webp$/);
  expect(errors).toEqual([]);
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

  const { filename, bytes } = await exportStills(page);
  expect(filename).toMatch(/^pikugo-stills-\d{8}-\d{6}\.zip$/);
  const entries = readZip(bytes);
  // One still per photo, in photo order, even though smooth bounce repeats frames.
  expect(entries.map((entry) => entry.name)).toEqual(["01-sample-1.png", "02-sample-2.png", "03-sample-3.png"]);
  for (const entry of entries) {
    expect(pngSize(entry.data)).toEqual({ width: animation.width, height: animation.height });
  }
  await expect(page.locator("#stillsBtn")).toBeEnabled();
  await expect(page.locator(".toast").last()).toContainText("Exported 3 PNG stills");
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

  const { bytes } = await exportStills(page);
  const entries = readZip(bytes);
  expect(entries.map((entry) => entry.name)).toEqual(["01-sample-1.jpg", "02-sample-2.jpg", "03-sample-3.jpg"]);
  await expect(page.locator(".toast").last()).toContainText("Exported 3 JPEG stills");

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
