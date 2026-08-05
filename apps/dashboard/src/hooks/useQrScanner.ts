import {useCallback, useEffect, useRef, useState, type RefObject} from "react";
import jsQR from "jsqr";

/// How long the same payload is ignored after a successful read. The camera sees the same QR
/// thirty times a second while an attendee holds up their phone; without this, one scan becomes
/// thirty identical ones.
const REPEAT_SUPPRESSION_MS = 3000;

/// `BarcodeDetector` would avoid this dependency, but Safari does not implement it and organizers
/// at an event are overwhelmingly on phones. A JS decoder is the only option that works on both,
/// so it is used everywhere rather than as a fallback — one code path is easier to trust than two.
export interface QrScannerOptions {
    onScan: (payload: string) => void;
}

export interface QrScanner {
    videoRef: RefObject<HTMLVideoElement>;
    isScanning: boolean;
    error: string | null;
    start: () => Promise<void>;
    stop: () => void;
}

export function useQrScanner({onScan}: QrScannerOptions): QrScanner {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const frameRef = useRef<number | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const lastPayloadRef = useRef<{payload: string; at: number} | null>(null);

    // Held in a ref so the scan loop, which is started once, always calls the current handler
    // rather than the one captured when the camera was switched on.
    const onScanRef = useRef(onScan);
    onScanRef.current = onScan;

    const [isScanning, setIsScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const stop = useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        // Releasing every track is what turns the camera indicator off. Leaving it running would
        // drain a phone that has to last the whole event.
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setIsScanning(false);
    }, []);

    const start = useCallback(async () => {
        setError(null);

        if (!navigator.mediaDevices?.getUserMedia) {
            setError("This browser cannot open a camera. Paste the address instead.");
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                // The rear camera is the one pointed at the attendee's phone.
                video: {facingMode: "environment"},
                audio: false,
            });
            streamRef.current = stream;

            const video = videoRef.current;
            if (!video) {
                stream.getTracks().forEach((t) => t.stop());
                return;
            }

            video.srcObject = stream;
            // Required for iOS Safari, which otherwise takes the video fullscreen.
            video.setAttribute("playsinline", "true");
            await video.play();
            setIsScanning(true);

            const canvas = (canvasRef.current ??= document.createElement("canvas"));
            const context = canvas.getContext("2d", {willReadFrequently: true});
            if (!context) {
                setError("Could not read frames from the camera.");
                stop();
                return;
            }

            const tick = () => {
                frameRef.current = requestAnimationFrame(tick);

                if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                if (canvas.width === 0 || canvas.height === 0) return;

                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const image = context.getImageData(0, 0, canvas.width, canvas.height);
                const found = jsQR(image.data, image.width, image.height, {inversionAttempts: "dontInvert"});
                if (!found?.data) return;

                const now = Date.now();
                const last = lastPayloadRef.current;
                if (last && last.payload === found.data && now - last.at < REPEAT_SUPPRESSION_MS) return;

                lastPayloadRef.current = {payload: found.data, at: now};
                onScanRef.current(found.data);
            };

            frameRef.current = requestAnimationFrame(tick);
        } catch (caught) {
            // Denied permission is by far the most likely cause, and is worth naming explicitly
            // because the fix is in browser settings rather than anything on this page.
            const message =
                caught instanceof DOMException && (caught.name === "NotAllowedError" || caught.name === "SecurityError")
                    ? "Camera permission denied. Allow it in your browser settings, or paste the address instead."
                    : caught instanceof Error
                      ? caught.message
                      : String(caught);
            setError(message);
            stop();
        }
    }, [stop]);

    // Unmounting while the camera is live must still release it — navigating away from the tab
    // is the most likely way an organizer "closes" the scanner.
    useEffect(() => stop, [stop]);

    return {videoRef, isScanning, error, start, stop};
}
