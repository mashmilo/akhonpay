package com.akhonpay.forwarder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsParserTest {
    @Test fun senderMapping() {
        assertEquals("bkash", SmsParser.providerFor("bKash"))
        assertEquals("bkash", SmsParser.providerFor("16247"))
        assertEquals("nagad", SmsParser.providerFor("NAGAD"))
        assertEquals("rocket", SmsParser.providerFor("16216"))
        assertNull(SmsParser.providerFor("bKash-Offers"))   // exact match only
        assertNull(SmsParser.providerFor("+8801712345678"))
        assertNull(SmsParser.providerFor(null))
    }

    @Test fun bkash() {
        val r = SmsParser.parse("bkash", "You have received Tk 500.00 from 01712345678. Fee Tk 0.00. Balance Tk 1,234.50. TrxID BLA12C34D5 at 27/10/2026 14:32")!!
        assertEquals("500.00", r.amount); assertEquals("01712345678", r.sender); assertEquals("BLA12C34D5", r.trxId)
    }

    @Test fun bkashThousands() {
        val r = SmsParser.parse("bkash", "You have received Tk 1,250.00 from 01912345678. Fee Tk 0.00. Balance Tk 9,999.00. TrxID 9K1A2B3C4D at 27/10/2026")!!
        assertEquals("1250.00", r.amount)
    }

    @Test fun nagad() {
        val r = SmsParser.parse("nagad", "Money Received.\nAmount: Tk 300.00\nSender: 01812345678\nRef: N/A\nTxnID: 72AB45CD\nBalance: Tk 800.00\n27/10/2026 10:11")!!
        assertEquals("300.00", r.amount); assertEquals("01812345678", r.sender); assertEquals("72AB45CD", r.trxId)
    }

    @Test fun rocket() {
        val r = SmsParser.parse("rocket", "Tk500.00 received from A/C: 01612345678 Fee: Tk0.00, Your A/C Balance: Tk2,000.00 TxnId: 1234567890 Date: 27/10/2026")!!
        assertEquals("500.00", r.amount); assertEquals("1234567890", r.trxId)
    }

    @Test fun internationalFormatNumber() {
        val r = SmsParser.parse("bkash", "You have received Tk 50 from +8801712345678. TrxID AB12CD34EF")!!
        assertEquals("01712345678", r.sender)
    }

    @Test fun ignoresOutgoingAndGarbage() {
        assertNull(SmsParser.parse("bkash", "Cash Out Tk 500.00 to 01712345678 successful. Fee Tk 9.25. TrxID BLA12C34D5"))
        assertNull(SmsParser.parse("bkash", "You have received a bonus! Win big."))
        assertNull(SmsParser.parse("bkash", "You have received Tk 500.00 from 01712345678."))  // no TrxID
    }
}
