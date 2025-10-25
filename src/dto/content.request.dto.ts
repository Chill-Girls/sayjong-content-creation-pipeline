import { z } from "zod";

export const contentCreationRequestSchema = z.object({
  songId: z.number().int().positive("songId는 양의 정수여야 합니다."),
  trackId: z.string().min(1, "trackId는 필수입니다."),
  title: z.string().min(1, "title은 필수입니다."),
});

export type ContentCreationRequest = z.infer<
  typeof contentCreationRequestSchema
>;
