"""Unit tests: FFmpeg preprocessor command + prompt-caching contract."""

from app import audio, llm


def test_ffmpeg_command_targets_16k_mono_s16(tmp_path, monkeypatch):
    src = tmp_path / "song.mp3"
    src.write_bytes(b"fake-audio")
    seen: dict = {}

    monkeypatch.setattr(audio.shutil, "which", lambda _b: "/usr/bin/ffmpeg")

    class Proc:
        returncode = 0
        stderr = ""

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        return Proc()

    monkeypatch.setattr(audio.subprocess, "run", fake_run)
    out = audio.normalize_to_wav16k(src)
    cmd = seen["cmd"]
    assert cmd[0] == "/usr/bin/ffmpeg"
    assert "-ac" in cmd and "1" in cmd
    assert "-ar" in cmd and "16000" in cmd
    assert "pcm_s16le" in cmd
    assert str(out).endswith(".16k.wav")


def test_ffmpeg_missing_binary_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(audio.shutil, "which", lambda _b: None)
    try:
        audio.normalize_to_wav16k(tmp_path / "x.mp3")
    except audio.FFmpegNotFoundError:
        pass
    else:
        raise AssertionError("expected FFmpegNotFoundError")


def test_system_prompts_carry_no_dynamic_song_data():
    for prompt in (llm.DRAFT_SYSTEM_PROMPT, llm.CRITIC_SYSTEM_PROMPT):
        assert "SONG DATA" not in prompt
        assert "onset_times_ms" not in prompt
        assert "±15ms" in prompt or "15ms" in prompt  # static grading rule present


def test_dynamic_song_data_lives_in_user_message():
    msg = llm.build_draft_user_message(
        bpm=128.0,
        onsets_ms=[0, 500],
        vocal_timestamps=[{"text": "hey", "start_ms": 0, "end_ms": 400}],
        motion_peaks_ms=[250],
        mode="mania-4k",
        title="T",
        duration_ms=5000,
    )
    assert "onset_times_ms" in msg
    assert "vocal_timestamps" in msg
    assert "128.0" in msg


def test_model_ids_are_exact():
    assert llm.VOICE_MODEL == "muse-voice-transcribe"
    assert llm.DRAFT_MODEL == "meta-models/muse-spark-open-1026"
    assert llm.CRITIC_MODEL_PROD == "muse-wonder-1.0"
    assert llm.CRITIC_MODEL_DEV == "muse-spark-1.3-contributor"
