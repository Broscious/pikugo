const uploadedImages = [];
let selectedImageIndex = -1;

const fileInput = document.getElementById("fileInput");
const imageGallery = document.getElementById("imageGallery");
const imageViewer = document.getElementById("imageViewer");
const viewerContainer = document.getElementById("viewerContainer");
const imageStage = document.getElementById("imageStage");
const selectedImage = document.getElementById("selectedImage");
const selectionMarker = document.getElementById("selectionMarker");
const prevButton = document.getElementById("prevBtn");
const nextButton = document.getElementById("nextBtn");
const createWiggleButton = document.getElementById("createWiggleBtn");
const wiggleSpinner = document.getElementById("wiggleSpinner");
const wiggleResult = document.getElementById("wiggleResult");
const downloadWiggleButton = document.getElementById("downloadWiggleBtn");
const processingCanvas = document.getElementById("processingCanvas");
const processingContext = processingCanvas.getContext("2d");

function clampPixelOffset(value, imageSize) {
    return Math.max(0, Math.min(Math.round(value), imageSize));
}

function imageSelectionAt(image, event) {
    const rect = image.getBoundingClientRect();
    return {
        x: clampPixelOffset(
            (event.clientX - rect.left) / rect.width * image.naturalWidth,
            image.naturalWidth,
        ),
        y: clampPixelOffset(
            (event.clientY - rect.top) / rect.height * image.naturalHeight,
            image.naturalHeight,
        ),
    };
}

function formatPercentage(value) {
    return `${value.toFixed(2)}%`;
}

function formatPixelOffsetPercentage(value, imageSize) {
    if (imageSize <= 0) {
        return "50%";
    }
    return formatPercentage(value / imageSize * 100);
}

function formatSelectionPercentage(image, selection) {
    return `${formatPixelOffsetPercentage(selection.x, image.naturalWidth)} ${formatPixelOffsetPercentage(selection.y, image.naturalHeight)}`;
}

function setMarkerPosition(marker, image, selection) {
    marker.style.left = formatPixelOffsetPercentage(selection.x, image.naturalWidth);
    marker.style.top = formatPixelOffsetPercentage(selection.y, image.naturalHeight);
    marker.style.display = "block";
}

function updateZoomOrigin(event) {
    const selection = imageSelectionAt(selectedImage, event);
    imageStage.style.transformOrigin = formatSelectionPercentage(selectedImage, selection);
}

function updateSelectedImage() {
    if (selectedImageIndex < 0 || selectedImageIndex >= uploadedImages.length) {
        return;
    }

    const uploadedImage = uploadedImages[selectedImageIndex];
    selectedImage.src = uploadedImage.dataURL;
    imageStage.style.transformOrigin = "center center";
    selectionMarker.style.display = "none";
    setMarkerPosition(selectionMarker, selectedImage, uploadedImage.selection);

    document.getElementById("imageCounter").textContent = `Image ${selectedImageIndex + 1} / ${uploadedImages.length}`;
    const galleryImages = imageGallery.querySelectorAll("img");
    galleryImages.forEach((image, index) => {
        image.classList.toggle("selected", index === selectedImageIndex);
    });

    prevButton.disabled = selectedImageIndex === 0;
    nextButton.disabled = selectedImageIndex === uploadedImages.length - 1;
}

function resetWiggleResult() {
    wiggleResult.src = "";
    wiggleResult.style.display = "none";
    downloadWiggleButton.href = "";
    downloadWiggleButton.style.display = "none";
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => resolve({
                dataURL: reader.result,
                image,
                selection: { x: 0, y: 0 },
            });
            image.onerror = () => reject(new Error(`Could not decode ${file.name}`));
            image.src = reader.result;
        };
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

async function handleFileSelection(event) {
    imageGallery.replaceChildren();
    uploadedImages.length = 0;
    selectedImageIndex = -1;
    createWiggleButton.disabled = true;
    resetWiggleResult();

    const files = Array.from(event.target.files);
    for (const file of files) {
        try {
            const uploadedImage = await loadImage(file);
            uploadedImages.push(uploadedImage);

            const galleryItem = document.createElement("div");
            galleryItem.className = "gallery-item";
            const thumbnail = document.createElement("img");
            thumbnail.src = uploadedImage.dataURL;
            thumbnail.alt = file.name;
            thumbnail.addEventListener("click", () => {
                selectedImageIndex = uploadedImages.indexOf(uploadedImage);
                updateSelectedImage();
            });
            galleryItem.appendChild(thumbnail);
            imageGallery.appendChild(galleryItem);
        } catch (error) {
            console.error(error);
        }
    }

    if (uploadedImages.length > 0) {
        selectedImageIndex = 0;
        createWiggleButton.disabled = false;
        imageViewer.style.display = "block";
        updateSelectedImage();
    }
}

function webPChunk(type, data) {
    const chunk = new Uint8Array(8 + data.length + (data.length % 2));
    for (let index = 0; index < 4; index += 1) {
        chunk[index] = type.charCodeAt(index);
    }
    new DataView(chunk.buffer).setUint32(4, data.length, true);
    chunk.set(data, 8);
    return chunk;
}

function concatenateBytes(parts) {
    const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

async function getWebPFrameData(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") {
        throw new Error("Browser did not produce a valid WebP frame");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameChunks = [];
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        const end = offset + 8 + size;
        if (end > bytes.length) {
            throw new Error("Browser produced an incomplete WebP frame");
        }
        if (type === "ALPH" || type === "VP8 " || type === "VP8L") {
            frameChunks.push(bytes.slice(offset, end + (size % 2)));
        }
        offset = end + (size % 2);
    }
    if (frameChunks.length === 0) {
        throw new Error("Could not read the encoded WebP frame");
    }
    return concatenateBytes(frameChunks);
}

async function createAnimatedWebP(frameBlobs, width, height) {
    const frameData = await Promise.all(frameBlobs.map(getWebPFrameData));
    const extendedHeader = new Uint8Array(10);
    extendedHeader[0] = 0x02;
    const headerView = new DataView(extendedHeader.buffer);
    headerView.setUint8(4, (width - 1) & 0xff);
    headerView.setUint8(5, ((width - 1) >> 8) & 0xff);
    headerView.setUint8(6, ((width - 1) >> 16) & 0xff);
    headerView.setUint8(7, (height - 1) & 0xff);
    headerView.setUint8(8, ((height - 1) >> 8) & 0xff);
    headerView.setUint8(9, ((height - 1) >> 16) & 0xff);

    const animationControl = new Uint8Array(6);
    new DataView(animationControl.buffer).setUint16(4, 0, true);
    const chunks = [webPChunk("VP8X", extendedHeader), webPChunk("ANIM", animationControl)];
    for (const data of frameData) {
        const frameHeader = new Uint8Array(16);
        const view = new DataView(frameHeader.buffer);
        view.setUint8(6, (width - 1) & 0xff);
        view.setUint8(7, ((width - 1) >> 8) & 0xff);
        view.setUint8(8, ((width - 1) >> 16) & 0xff);
        view.setUint8(9, (height - 1) & 0xff);
        view.setUint8(10, ((height - 1) >> 8) & 0xff);
        view.setUint8(11, ((height - 1) >> 16) & 0xff);
        view.setUint16(12, 500, true);
        view.setUint8(15, 0x02);
        chunks.push(webPChunk("ANMF", concatenateBytes([frameHeader, data])));
    }

    const body = concatenateBytes([new TextEncoder().encode("WEBP"), ...chunks]);
    const riff = new Uint8Array(8 + body.length);
    riff.set(new TextEncoder().encode("RIFF"));
    new DataView(riff.buffer).setUint32(4, riff.length - 8, true);
    riff.set(body, 8);
    return new Blob([riff], { type: "image/webp" });
}

async function processWebP() {
    const frameWidth = Math.min(...uploadedImages.map(({ image }) => image.naturalWidth));
    const frameHeight = Math.min(...uploadedImages.map(({ image }) => image.naturalHeight));
    if (frameWidth <= 0 || frameHeight <= 0) {
        throw new Error("Image dimensions must be positive");
    }

    processingCanvas.width = frameWidth;
    processingCanvas.height = frameHeight;
    const frameBlobs = [];
    for (const { image } of uploadedImages) {
        processingContext.clearRect(0, 0, frameWidth, frameHeight);
        processingContext.drawImage(image, 0, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
        const blob = await new Promise((resolve, reject) => {
            processingCanvas.toBlob(result => {
                if (result === null) {
                    reject(new Error("Browser could not encode WebP"));
                    return;
                }
                resolve(result);
            }, "image/webp", 0.85);
        });
        frameBlobs.push(blob);
    }

    if (frameBlobs.length === 1) {
        return frameBlobs[0];
    }
    return createAnimatedWebP(frameBlobs, frameWidth, frameHeight);
}

async function createWebP() {
    if (uploadedImages.length === 0 || createWiggleButton.disabled) {
        return;
    }

    createWiggleButton.disabled = true;
    wiggleSpinner.style.display = "inline-block";
    const startedAt = performance.now();

    try {
        const webPBlob = await processWebP();
        const webPURL = URL.createObjectURL(webPBlob);
        wiggleResult.src = webPURL;
        wiggleResult.style.display = "block";
        downloadWiggleButton.href = webPURL;
        downloadWiggleButton.download = "wiggle.webp";
        downloadWiggleButton.style.display = "inline-block";
        console.log(`WebP processing took ${((performance.now() - startedAt) / 1000).toFixed(3)}s`);
    } catch (error) {
        console.error(error);
    } finally {
        wiggleSpinner.style.display = "none";
        createWiggleButton.disabled = false;
    }
}

viewerContainer.addEventListener("mousemove", updateZoomOrigin);
viewerContainer.addEventListener("mouseenter", () => imageStage.classList.add("zoomed"));
viewerContainer.addEventListener("mouseleave", () => {
    imageStage.classList.remove("zoomed");
    imageStage.style.transformOrigin = "center center";
});
selectedImage.addEventListener("click", event => {
    if (selectedImageIndex < 0) {
        return;
    }
    const selection = imageSelectionAt(selectedImage, event);
    uploadedImages[selectedImageIndex].selection = selection;
    setMarkerPosition(selectionMarker, selectedImage, selection);
});
fileInput.addEventListener("change", handleFileSelection);
prevButton.addEventListener("click", () => {
    if (selectedImageIndex > 0) {
        selectedImageIndex -= 1;
        updateSelectedImage();
    }
});
nextButton.addEventListener("click", () => {
    if (selectedImageIndex < uploadedImages.length - 1) {
        selectedImageIndex += 1;
        updateSelectedImage();
    }
});
createWiggleButton.addEventListener("click", createWebP);
