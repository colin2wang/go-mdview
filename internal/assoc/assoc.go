package assoc

// AssocState is the file association state shown in the settings dialog.
type AssocState struct {
	Supported  bool   `json:"supported"`  // whether the platform supports association (Windows only)
	ExePath    string `json:"exePath"`    // current executable path
	Associated bool   `json:"associated"` // whether .md points to mdview
	Owner      string `json:"owner"`      // current default handler when unassociated; empty means unset
	Message    string `json:"message"`    // description or error of the last operation
}
