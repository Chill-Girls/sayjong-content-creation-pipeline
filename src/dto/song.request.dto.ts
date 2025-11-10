import { z } from "zod";

export const songTimingCreationRequestSchema = z.object({
  songId: z.number().int().positive("songId는 양의 정수여야 합니다."),
});

export type SongTimingCreationRequest = z.infer<
  typeof songTimingCreationRequestSchema
>;
