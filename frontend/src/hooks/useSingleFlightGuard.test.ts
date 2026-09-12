import { act, renderHook } from "@testing-library/react";
import { useSingleFlightGuard } from "./useSingleFlightGuard";

describe("useSingleFlightGuard", () => {
  it("rejeita a segunda execução síncrona até a primeira finalizar", () => {
    const { result } = renderHook(() => useSingleFlightGuard());

    expect(result.current.tryStart()).toBe(true);
    expect(result.current.tryStart()).toBe(false);

    act(() => {
      result.current.finish();
    });

    expect(result.current.tryStart()).toBe(true);
  });
});
