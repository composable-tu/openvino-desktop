//go:build !windows

package main

import "os/user"

func getUserLanguage() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	// On non-Windows, try to infer from username or return empty
	_ = u
	return "", nil
}
