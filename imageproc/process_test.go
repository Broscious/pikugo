package imageproc

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"testing"
	"time"
)

func TestProcessWiggleCreatesOneFramePerImage(t *testing.T) {
	request := WiggleRequest{
		Images: []ImageInput{
			{Image: solidImage(color.RGBA{R: 255, A: 255}), Selection: image.Point{}},
			{Image: solidImage(color.RGBA{B: 255, A: 255}), Selection: image.Point{}},
		},
		Options: WiggleOptions{FrameDuration: 100 * time.Millisecond},
	}

	result, err := ProcessWiggle(request)
	if err != nil {
		t.Fatalf("ProcessWiggle returned an error: %v", err)
	}
	decoded, err := gif.DecodeAll(bytes.NewReader(result.GIF))
	if err != nil {
		t.Fatalf("decode generated GIF: %v", err)
	}
	if got, want := len(decoded.Image), len(request.Images); got != want {
		t.Fatalf("generated %d frames, want %d", got, want)
	}
	if got, want := decoded.Delay, []int{10, 10}; !equalInts(got, want) {
		t.Fatalf("frame delays = %v, want %v", got, want)
	}
}

func TestProcessWiggleCropsImagesToCommonDimensions(t *testing.T) {
	request := WiggleRequest{
		Images: []ImageInput{
			{Image: image.NewRGBA(image.Rect(0, 0, 4, 3))},
			{Image: image.NewRGBA(image.Rect(0, 0, 2, 5))},
		},
		Options: WiggleOptions{FrameDuration: 100 * time.Millisecond},
	}

	result, err := ProcessWiggle(request)
	if err != nil {
		t.Fatalf("ProcessWiggle returned an error: %v", err)
	}
	decoded, err := gif.DecodeAll(bytes.NewReader(result.GIF))
	if err != nil {
		t.Fatalf("decode generated GIF: %v", err)
	}
	for index, frame := range decoded.Image {
		if got, want := frame.Bounds(), image.Rect(0, 0, 2, 3); got != want {
			t.Fatalf("frame %d bounds = %v, want %v", index, got, want)
		}
	}
}

func solidImage(pixel color.Color) image.Image {
	result := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			result.Set(x, y, pixel)
		}
	}
	return result
}

func equalInts(first, second []int) bool {
	if len(first) != len(second) {
		return false
	}
	for index := range first {
		if first[index] != second[index] {
			return false
		}
	}
	return true
}
