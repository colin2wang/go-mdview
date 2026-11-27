//go:build !windows

package assoc

import "errors"

// errAssocUnsupported marks platforms without registry-based association.
var errAssocUnsupported = errors.New("file association is only supported on Windows")

// ExePath returns the current executable path.
func ExePath() string { return "" }

// GetAssocState reports that association is unsupported on this platform.
func GetAssocState() AssocState {
	return AssocState{Supported: false, Owner: "", Message: errAssocUnsupported.Error()}
}

// AssociateMd is unsupported on non-Windows platforms.
func AssociateMd() error { return errAssocUnsupported }

// UnassociateMd is unsupported on non-Windows platforms.
func UnassociateMd() error { return errAssocUnsupported }
