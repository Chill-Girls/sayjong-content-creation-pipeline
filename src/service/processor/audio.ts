import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import * as crypto from "crypto";
import { Readable } from "stream";
import { Storage, Bucket } from "@google-cloud/storage";

class AudioService {
  private client: ElevenLabsClient;
  private storage: Storage;
  private bucket: Bucket;
  private bucketName: string;

  private audioCache = new Map<string, string>();

  private readonly KOREAN_VOICE_ID = "uyVNoMrnUku1dZyVEXwD"; //Anna kim

  constructor() {
    // 1. ElevenLabs 클라이언트 설정
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ELEVENLABS_API_KEY가 .env 파일에 설정되지 않았습니다. ElevenLabs API 키를 확인해주세요."
      );
    }

    this.client = new ElevenLabsClient({ apiKey });

    // 2. Google Cloud Storage 클라이언트 설정
    const gcpProjectId = process.env.GCP_PROJECT_ID;
    const gcsBucketName = process.env.GCS_BUCKET_NAME;
    const gcpKeyFilePath = process.env.GCP_SERVICE_KEY_PATH;

    if (!gcpProjectId || !gcsBucketName || !gcpKeyFilePath) {
      throw new Error(
        "GCP_PROJECT_ID, GCS_BUCKET_NAME, GCP_SERVICE_KEY_PATH가 .env에 모두 설정되어야 합니다."
      );
    }

    this.storage = new Storage({
      projectId: gcpProjectId,
      keyFilename: gcpKeyFilePath,
    });
    this.bucketName = gcsBucketName;
    this.bucket = this.storage.bucket(this.bucketName);
  }

  public async createTTS(text: string): Promise<string> {
    const trimmedText = text.trim();

    if (this.audioCache.has(trimmedText)) {
      console.log(`[AudioService] 캐시된 TTS 사용: "${text}"`);
      return this.audioCache.get(trimmedText)!;
    }

    if (!trimmedText) {
      console.warn(`[AudioService] 빈 텍스트는 스킵합니다.`);
      return "";
    }

    const hasHangul = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(trimmedText);
    if (!hasHangul) {
      console.warn(`[AudioService] 한글이 포함되지 않은 텍스트는 스킵합니다.`);
      return "";
    }

    console.log(`[AudioService] TTS 생성 요청: "${trimmedText}"`);

    try {
      const audioStream = await this.client.textToSpeech.stream(
        this.KOREAN_VOICE_ID,
        {
          text: trimmedText,
          modelId: "eleven_multilingual_v2",
        }
      );

      const gcsFilePath = `tts/${crypto.randomUUID()}.mp3`;
      const file = this.bucket.file(gcsFilePath);
      const gcsWriteStream = file.createWriteStream({
        contentType: "audio/mpeg",
      });
      const nodeAudioStream = Readable.fromWeb(audioStream as any);
      nodeAudioStream.pipe(gcsWriteStream);

      return new Promise((resolve, reject) => {
        gcsWriteStream.on("finish", () => {
          const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${gcsFilePath}`;
          this.audioCache.set(trimmedText, publicUrl);
          resolve(publicUrl);
        });
        gcsWriteStream.on("error", (error) => {
          console.error("[AudioService] 파일 쓰기 스트림 에러:", error);
          reject(error);
        });
        nodeAudioStream.on("error", (error) => {
          console.error("[AudioService] ElevenLabs API 스트림 에러:", error);
          reject(error);
        });
      });
    } catch (error) {
      console.error(
        `[AudioService] ElevenLabs TTS 생성 실패 (text: ${text}):`,
        error
      );
      if (error instanceof Error) {
        throw new Error(`ElevenLabs TTS failed: ${error.message}`);
      }
      throw new Error(
        `ElevenLabs TTS failed: ${String(error) || "Unknown error"}`
      );
    }
  }
}

export const audioService = new AudioService();
