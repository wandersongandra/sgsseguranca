import { act, renderHook } from "@testing-library/react";
import { useApprovalWorkflow } from "./useApprovalWorkflow";

jest.mock("@/lib/error-handler", () => ({
  handleApiError: jest.fn(),
}));

describe("useApprovalWorkflow", () => {
  it("ignora uma segunda decisão enquanto a primeira está em andamento", async () => {
    let resolveFirst!: () => void;
    const firstOperation = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const action = jest.fn(() => firstOperation);
    const { result } = renderHook(() => useApprovalWorkflow());

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.execute("approve", action);
      second = result.current.execute("approve", action);
      await Promise.resolve();
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(await second).toBeUndefined();

    resolveFirst();
    await act(async () => {
      await first;
    });
  });
});
