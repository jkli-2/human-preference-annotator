# Extract nearest frame to t (seconds) and crop region
ffmpeg -ss 12.345 -i input.mp4 -frames:v 1 -vf "crop=w_p:h_p:x_p:y_p" -y out.png
