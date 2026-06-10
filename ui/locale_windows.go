//go:build windows

package main

import (
	"golang.org/x/sys/windows/registry"
)

func getUserLanguage() (string, error) {
	key, err := registry.OpenKey(
		registry.CURRENT_USER,
		`Control Panel\Desktop`,
		registry.READ,
	)
	if err != nil {
		return "", err
	}
	defer key.Close()

	// Windows stores UI language in "PreferredUILanguages" (REG_MULTI_SZ)
	val, _, err := key.GetStringValue("PreferredUILanguages")
	if err != nil {
		// Fallback: try MUI_Cached-Language
		val, _, err = key.GetStringValue("MUI_Cached-Language")
		if err != nil {
			return "", err
		}
	}
	if len(val) > 0 {
		return val, nil
	}
	return "", nil
}
