package space.davids_digital.giexchange.contracts

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PrimitivesTest {
    @Test
    fun `Can't create Credits object with negative value`() {
        assertThrows<IllegalArgumentException> { Credits(-1) }
        assertThrows<IllegalArgumentException> { Credits(1) * -1 }
    }

    @Test
    fun `Credits can be compared`() {
        assertTrue { Credits(1) > Credits(0) }
        assertEquals(Credits(0), Credits(0))
    }

    @Test
    fun `Credits addition is overflow-proof`() {
        // (2^63 - 1) + 1
        assertThrows<ArithmeticException> { Credits(9223372036854775807) + Credits(1) }
        // (2^63 - 1) + (2^63 - 1)
        assertThrows<ArithmeticException> { Credits(9223372036854775807) + Credits(9223372036854775807) }
    }

    @Test
    fun `Credits multiplication is overflow-proof`() {
        // 2^62 * 2
        assertThrows<ArithmeticException> { Credits(4611686018427387904) * 2 }
        // 2^62 * 4
        assertThrows<ArithmeticException> { Credits(4611686018427387904) * 4 }
        // 2^62 * 2^62
        assertThrows<ArithmeticException> { Credits(4611686018427387904) * 4611686018427387904 }
    }

    @Test
    fun `MarketKey creation requirements are enforced`() {
        assertDoesNotThrow { MarketKey("test-game/test-item") }
        assertDoesNotThrow { MarketKey("test-game/test-item?attr_2=v_a_l_u_e&my-attribute=my-value") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game/MyItem") } // Uppercase letters
        assertThrows<IllegalArgumentException> { MarketKey("test-game/test-item?") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game/test-item?attr") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game/test-item?attr=") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game/test-item?attr=Value") }
        assertThrows<IllegalArgumentException> { MarketKey("test-game/test-item?attr=value&") }
        assertThrows<IllegalArgumentException> { MarketKey("g/i?a=1&a=2") } // Duplicate attributes
        assertThrows<IllegalArgumentException> { MarketKey("g/i?b=1&a=2") } // Unsorted attributes
        assertEquals(
            MarketKey("test-game/test-item?attr_2=v_a_l_u_e&my-attribute=my-value"),
            MarketKey.of("test-game", "test-item", mapOf("my-attribute" to "my-value", "attr_2" to "v_a_l_u_e"))
        )
    }

    @Test
    fun `MarketKey attributes are sorted`() {
        assertEquals(
            MarketKey("test-game/test-item?a=1&b=2&c=v_a_l_u_e"),
            MarketKey.of("test-game", "test-item", mapOf("c" to "v_a_l_u_e", "b" to "2", "a" to "1"))
        )
    }
}
