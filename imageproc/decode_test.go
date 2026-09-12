package imageproc

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"testing"
)

func TestDecodeDataURL(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2, 3))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatalf("encode test image: %v", err)
	}

	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	decoded, err := DecodeDataURL(dataURL)
	if err != nil {
		t.Fatalf("DecodeDataURL returned an error: %v", err)
	}
	if got, want := decoded.Bounds(), image.Rect(0, 0, 2, 3); got != want {
		t.Fatalf("decoded bounds = %v, want %v", got, want)
	}
}
