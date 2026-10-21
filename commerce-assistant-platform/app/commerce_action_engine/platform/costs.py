"""Integer-only estimates from operator-supplied model pricing."""


def estimated_micros(
    input_tokens: int,
    output_tokens: int,
    input_per_1k_micros: int,
    output_per_1k_micros: int,
) -> int:
    if min(input_tokens, output_tokens, input_per_1k_micros, output_per_1k_micros) < 0:
        raise ValueError("cost inputs cannot be negative")
    return (
        input_tokens * input_per_1k_micros + output_tokens * output_per_1k_micros
    ) // 1000
