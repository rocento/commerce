package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRocentoUnsignedTrailerDeniedBeforeHandler(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		path   string
		header http.Header
	}{
		{"put", http.MethodPut, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {unsignedPayloadTrailer}}},
		{"multipart-route", http.MethodPut, "/fixture/object?partNumber=1&uploadId=fixture", http.Header{"X-Amz-Content-Sha256": {unsignedPayloadTrailer}}},
		{"get", http.MethodGet, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {unsignedPayloadTrailer}}},
		{"post", http.MethodPost, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {unsignedPayloadTrailer}}},
		{"lowercase-name", http.MethodPut, "/fixture/object", http.Header{"x-amz-content-sha256": {unsignedPayloadTrailer}}},
		{"duplicate-last", http.MethodPut, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {"UNSIGNED-PAYLOAD", unsignedPayloadTrailer}}},
		{"duplicate-first", http.MethodPut, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {unsignedPayloadTrailer, "UNSIGNED-PAYLOAD"}}},
		{"combined-values", http.MethodPut, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {"UNSIGNED-PAYLOAD, " + unsignedPayloadTrailer}}},
		{"trimmed-lowercase-value", http.MethodPut, "/fixture/object", http.Header{"X-Amz-Content-Sha256": {" streaming-unsigned-payload-trailer "}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader("ordinary fixture content"))
			r.Header = tc.header
			called := false
			h := setAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if called {
				t.Fatal("unsupported unsigned trailer reached downstream handler")
			}
			want := errorCodes.ToAPIErr(ErrSignatureVersionNotSupported)
			if w.Code != want.HTTPStatusCode || !strings.Contains(w.Body.String(), "<Code>"+want.Code+"</Code>") {
				t.Fatalf("unexpected denial status/code: %d", w.Code)
			}
		})
	}
}

func TestRocentoUnsignedTrailerOtherModesReachHandler(t *testing.T) {
	for _, payloadHash := range []string{
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"UNSIGNED-PAYLOAD",
		streamingContentSHA256,
		streamingContentSHA256Trailer,
	} {
		t.Run(payloadHash, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, "/fixture/object", nil)
			r.Header.Set("X-Amz-Content-Sha256", payloadHash)
			r.Header.Set("X-Amz-Date", time.Now().UTC().Format("20060102T150405Z"))
			r.Header.Set("Authorization", "AWS4-HMAC-SHA256 fixture")
			called := false
			w := httptest.NewRecorder()
			setAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, r)
			if !called || w.Code != http.StatusNoContent {
				t.Fatalf("other payload mode blocked by middleware: %d", w.Code)
			}
		})
	}
}
