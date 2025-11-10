import { z } from "zod";

export const lineTTSCreationRequestSchema = z.object({
  lyricLineId: z.number().int().positive("lyricLineId는 양의 정수여야 합니다."),
  lyricText: z.string(),
});

export type LineTTSCreationRequest = z.infer<
  typeof lineTTSCreationRequestSchema
>;
