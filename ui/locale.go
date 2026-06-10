package main

import (
	"github.com/Xuanwo/go-locale"
)

func getUserLanguage() (string, error) {
	tag, err := locale.Detect()
	if err != nil {
		return "", err
	}
	return tag.String(), nil
}
