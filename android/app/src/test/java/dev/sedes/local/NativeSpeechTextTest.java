package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeSpeechTextTest {
    private String clean(String text) { return NativeSpeechText.prepare(text, true); }

    @Test public void rendersFormattingAndBlockPauses() {
        assertEquals("Heading\n\nBold, emphasis, and old.\n\nQuoted\n\nFirst\n\nSecond",
            clean("# Heading\n\n**Bold**, *emphasis*, and ~~old~~.\n\n> Quoted\n\n- First\n- Second"));
        assertEquals("3. Third\n\n4. Fourth", clean("3. Third\n4. Fourth"));
    }
    @Test public void readsLinkLabelsAndImageDescriptionsWithoutHiddenDestinations() {
        assertEquals("Read the guide and a red fox.\n\nReference label",
            clean("Read [the **guide**](https://example.test/long?secret=value \"Title\") and ![a red fox](image.png).\n\n[Reference label][ref]\n\n[ref]: https://example.test"));
        assertEquals("https://example.test/path", clean("<https://example.test/path>"));
    }
    @Test public void preservesCodeContentAndOrdinarySymbols() {
        assertEquals("Use C#, foo_bar, 2 * 3, x < y > z, and #42. Literal *stars*.",
            clean("Use C#, foo_bar, 2 * 3, x < y > z, and #42. Literal \\*stars\\*."));
        assertEquals("Run foo_bar(x * 2).\n\n# keep this comment\nx = a_b * 2;\n\n**literal**",
            clean("Run `foo_bar(x * 2)`.\n\n```python\n# keep this comment\nx = a_b * 2;\n```\n\n    **literal**\n"));
        assertEquals("<b>source</b>", clean("<b>source</b>"));
    }
    @Test public void rendersTablesAndCheckboxMeaning() {
        assertEquals("Name; State\n\nService; Ready", clean("| Name | State |\n| --- | --- |\n| **Service** | Ready |"));
        assertEquals("Checked: Done\n\nUnchecked: Pending", clean("- [x] Done\n- [ ] Pending"));
    }
    @Test public void keepsHardBreaksAndNormalizesWhitespace() {
        assertEquals("Soft line\nhard\nbreak\n\nNext paragraph", clean("Soft\nline  \nhard\\\nbreak\n\nNext\t paragraph  "));
        assertEquals("Fish & chips — café 🦦", clean("Fish &amp; chips — café 🦦"));
    }
    @Test public void emptyFormattingDoesNotBecomeAnUtterance() {
        for (String source : new String[] { "", " \n\t", "---", "#", "```\n```", "[ref]: https://example.test" })
            assertEquals(source, "", clean(source));
    }
    @Test public void disabledCleanupReturnsTheExactInput() {
        String source = " \t# Heading\n\n[link](https://example.test)\n```\n a_b * 2\n```\n";
        assertEquals(source, NativeSpeechText.prepare(source, false));
    }
    @Test(timeout = 3000) public void boundsDeepNestingAndKeepsUnfinishedText() {
        String nested = "> ".repeat(2000) + "Still here 🦦";
        assertTrue(clean(nested).contains("Still here 🦦"));
        assertEquals("Unfinished **answer [label", clean("Unfinished **answer [label"));
    }
}
