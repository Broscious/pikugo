package imageproc

import (
	"bytes"
	"fmt"
	"image"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"time"
)

type WiggleResult struct {
	GIF []byte
}

func ProcessWiggle(request WiggleRequest) (WiggleResult, error) {
	if len(request.Images) == 0 {
		return WiggleResult{}, fmt.Errorf("wiggle request contains no images")
	}
	if request.Options.FrameDuration <= 0 {
		return WiggleResult{}, fmt.Errorf("frame duration must be positive")
	}

	frameWidth := 0
	frameHeight := 0
	for index, input := range request.Images {
		if input.Image == nil {
			return WiggleResult{}, fmt.Errorf("image %d is nil", index)
		}

		bounds := input.Image.Bounds()
		if bounds.Dx() == 0 || bounds.Dy() == 0 {
			return WiggleResult{}, fmt.Errorf("image %d dimensions must be positive", index)
		}
		if frameWidth == 0 || bounds.Dx() < frameWidth {
			frameWidth = bounds.Dx()
		}
		if frameHeight == 0 || bounds.Dy() < frameHeight {
			frameHeight = bounds.Dy()
		}
	}

	animation := &gif.GIF{
		LoopCount: 0,
		Delay:     make([]int, 0, len(request.Images)),
		Image:     make([]*image.Paletted, 0, len(request.Images)),
	}
	frameDelay := int(request.Options.FrameDuration / (10 * time.Millisecond))
	if frameDelay < 1 {
		frameDelay = 1
	}

	for _, input := range request.Images {
		frame := image.NewPaletted(image.Rect(0, 0, frameWidth, frameHeight), palette.Plan9)
		draw.Draw(frame, frame.Bounds(), input.Image, input.Image.Bounds().Min, draw.Src)
		animation.Image = append(animation.Image, frame)
		animation.Delay = append(animation.Delay, frameDelay)
	}

	var encoded bytes.Buffer
	if err := gif.EncodeAll(&encoded, animation); err != nil {
		return WiggleResult{}, fmt.Errorf("encode wiggle GIF: %w", err)
	}

	return WiggleResult{GIF: encoded.Bytes()}, nil
}
