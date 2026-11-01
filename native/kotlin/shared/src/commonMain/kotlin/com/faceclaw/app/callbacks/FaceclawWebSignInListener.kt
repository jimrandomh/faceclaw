package com.faceclaw.app

interface FaceclawWebSignInListener {
    /**
     * The sign-in ended: the redirect URL (query included), or null with why
     * not ("cancelled" when it was cancelled or replaced by another sign-in).
     */
    fun onFinished(redirectUrl: String?, error: String?): Unit
}
