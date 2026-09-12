package imageproc

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

func DecodeDataURL(dataURL string) (image.Image, error) {
	const encodedMarker = ";base64,"

	markerIndex := strings.Index(dataURL, encodedMarker)
	if markerIndex == -1 {
		return nil, fmt.Errorf("image data URL is not base64 encoded")
	}

	encodedData := dataURL[markerIndex+len(encodedMarker):]
	data, err := base64.StdEncoding.DecodeString(encodedData)
	if err != nil {
		return nil, fmt.Errorf("decode image data URL: %w", err)
	}

	decodedImage, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image data: %w", err)
	}

	return decodedImage, nil
}
