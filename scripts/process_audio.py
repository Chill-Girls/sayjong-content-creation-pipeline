import sys
import json
import stable_whisper

# 인자가 3개(스크립트, 오디오파일, 가사)여야 함
if len(sys.argv) < 3:
    print(
        json.dumps({"error": "Audio file path and lyrics text are required."}),
        file=sys.stderr,
    )
    sys.exit(1)

audio_file_path = sys.argv[1]
lyrics_text = sys.argv[2]

try:
    model = stable_whisper.load_model("small")  # large-v3

    result = model.align(
        audio_file_path,
        lyrics_text,
        language="en",  # language="ko",
        regroup=False,
        # word_timestamps=True,
        verbose=False,
    )
    word_list = []
    for segment in result.segments:
        for word in segment.words:
            word_list.append(
                {"word": word.word.strip(), "start": word.start, "end": word.end}
            )

    print(json.dumps(word_list, ensure_ascii=False))

except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
