import { expect, test, type Page } from "@playwright/test";
import { inspectAnimation, readChunks } from "../src/core/webp";

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
  expect(info.frames).toHaveLength(3);
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
  await page.getByRole("radio", { name: "Bounce" }).click();
  await expect(page.locator("#delayHint")).toContainText("4.0 fps");
  const info = inspectAnimation(await generate(page));
  expect(info.frames).toHaveLength(4);
  expect(info.frames.map((frame) => frame.duration)).toEqual([250, 250, 250, 250]);
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
  await page.getByRole("radio", { name: "Fixed" }).click();
  await page.getByRole("button", { name: "Top left" }).click();
  await expect(page.locator("#anchorXOut")).toHaveText("0%");
  await expect(page.locator("#anchorYOut")).toHaveText("0%");
  const info = inspectAnimation(await generate(page));
  // The subject sits in the top-left corner, so only the space below/right of it is usable.
  expect(info.width).toBeLessThan(600);
  expect(info.height).toBeLessThan(300);
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
