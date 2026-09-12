package imageproc

import (
	"image"
	"testing"
	"time"
)

func TestDefaultWiggleOptions(t *testing.T) {
	options := DefaultWiggleOptions()

	if options.FrameDuration != 100*time.Millisecond {
		t.Fatalf("FrameDuration = %v, want 100ms", options.FrameDuration)
	}
	if !options.Reverse {
		t.Fatal("Reverse = false, want true")
	}
	if options.ExportIndividualFrames {
		t.Fatal("ExportIndividualFrames = true, want false")
	}
	if !options.ExportGIF {
		t.Fatal("ExportGIF = false, want true")
	}
}

func TestWiggleRequestKeepsImageSelectionsTogether(t *testing.T) {
	first := image.NewRGBA(image.Rect(0, 0, 10, 10))
	second := image.NewRGBA(image.Rect(0, 0, 20, 20))
	request := WiggleRequest{
		Images: []ImageInput{
			{Image: first, Selection: image.Point{X: 2, Y: 3}},
			{Image: second, Selection: image.Point{X: 7, Y: 11}},
		},
		Options: DefaultWiggleOptions(),
	}

	if request.Images[0].Image != first || request.Images[0].Selection != (image.Point{X: 2, Y: 3}) {
		t.Fatal("first image and selection were not kept together")
	}
	if request.Images[1].Image != second || request.Images[1].Selection != (image.Point{X: 7, Y: 11}) {
		t.Fatal("second image and selection were not kept together")
	}
}
