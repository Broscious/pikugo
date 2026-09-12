package imageproc

import (
	"image"
	"time"
)

type ImageInput struct {
	Image     image.Image
	Selection image.Point
}

type WiggleOptions struct {
	FrameDuration          time.Duration
	Reverse                bool
	ExportIndividualFrames bool
	ExportGIF              bool
}

func DefaultWiggleOptions() WiggleOptions {
	return WiggleOptions{
		FrameDuration: 100 * time.Millisecond,
		Reverse:       true,
		ExportGIF:     true,
	}
}

type WiggleRequest struct {
	Images  []ImageInput
	Options WiggleOptions
}
