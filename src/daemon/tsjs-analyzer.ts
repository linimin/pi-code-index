export interface TsJsAnalyzerInput {
  path: string;
  content: string;
}

export interface TsJsSymbolFact {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export class TsJsAnalyzer {
  async analyze(_input: TsJsAnalyzerInput): Promise<TsJsSymbolFact[]> {
    throw new Error("TsJsAnalyzer.analyze() is not implemented yet.");
  }
}
