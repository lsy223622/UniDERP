package control

import (
	"embed"
	"net/http"
)

//go:embed ui/index.html ui/app.js ui/theme.js ui/i18n.js ui/locales/*.js ui/derp-policy.js ui/vendor/jsonc-parser.js ui/app.css ui/fonts/InterVariable.woff2
var managementFiles embed.FS

func serveManagement(w http.ResponseWriter, r *http.Request) bool {
	var file, contentType string
	switch r.URL.Path {
	case "/manage/":
		file, contentType = "ui/index.html", "text/html; charset=utf-8"
	case "/manage/app.js":
		file, contentType = "ui/app.js", "text/javascript; charset=utf-8"
	case "/manage/theme.js":
		file, contentType = "ui/theme.js", "text/javascript; charset=utf-8"
	case "/manage/derp-policy.js":
		file, contentType = "ui/derp-policy.js", "text/javascript; charset=utf-8"
	case "/manage/vendor/jsonc-parser.js":
		file, contentType = "ui/vendor/jsonc-parser.js", "text/javascript; charset=utf-8"
	case "/manage/i18n.js":
		file, contentType = "ui/i18n.js", "text/javascript; charset=utf-8"
	case "/manage/locales/zh-CN.js":
		file, contentType = "ui/locales/zh-CN.js", "text/javascript; charset=utf-8"
	case "/manage/locales/en.js":
		file, contentType = "ui/locales/en.js", "text/javascript; charset=utf-8"
	case "/manage/app.css":
		file, contentType = "ui/app.css", "text/css; charset=utf-8"
	case "/manage/fonts/InterVariable.woff2":
		file, contentType = "ui/fonts/InterVariable.woff2", "font/woff2"
	default:
		return false
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'")
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return true
	}
	asset, err := managementFiles.ReadFile(file)
	if err != nil {
		http.Error(w, "management asset unavailable", 500)
		return true
	}
	w.Header().Set("Content-Type", contentType)
	if r.Method != "HEAD" {
		w.Write(asset)
	}
	return true
}
