global ITERS: u32 = 19252;
fn main(x: Field) -> pub Field {
    let mut acc = x;
    for _ in 0..ITERS {
        let p: [Field; 4] = std::hash::poseidon2_permutation([acc, acc + 1, acc + 2, acc + 3]);
        acc = p[0] + p[1] + p[2] + p[3];
    }
    acc
}
