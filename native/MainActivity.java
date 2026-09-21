package com.aem.store;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AemInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
