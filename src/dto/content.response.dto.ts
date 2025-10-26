import { z } from "zod";

export const processedLyricSyllableSchema = z.object({
  textKor: z.string(),
  romanized: z.string(),
  nativeAudio: z.url(),
});

export const processedLyricLineSchema = z.object({
  startTime: z.string(),
  words: z.string(),
  romanized: z.string(),
  translated: z.string(),
  nativeAudio: z.url(),
  syllables: z.array(processedLyricSyllableSchema),
});

export const contentSuccessResultSchema = z.object({
  songId: z.number().int().positive(),
  title: z.string().min(1),
  titleTranslated: z.string().min(1),
  lines: z.array(processedLyricLineSchema),
});

export const contentFailResultSchema = z.object({
  songId: z.number().int().positive(),
  error: z.string().min(1, "에러 메시지는 필수입니다."),
});

export type ProcessedLyricSyllable = z.infer<
  typeof processedLyricSyllableSchema
>;
export type ProcessedLyricLine = z.infer<typeof processedLyricLineSchema>;
export type ContentSuccessResult = z.infer<typeof contentSuccessResultSchema>;
export type ContentFailResult = z.infer<typeof contentFailResultSchema>;
