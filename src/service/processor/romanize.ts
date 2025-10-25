import { romanize } from "es-hangul";

class RomanizeService {
  public convert(text: string) {
    if (!text) {
      return "";
    }
    return romanize(text);
  }
}

export const romanizeService = new RomanizeService();
